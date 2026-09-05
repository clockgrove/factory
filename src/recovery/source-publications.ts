import { attemptRef } from "../control/attempts.js";
import { loadCompiledGraph, loadCompiledGraphProjection } from "../control/graphs.js";
import { decodeEventTrailer } from "../control/receipts.js";
import { loadReviewCheckpoint } from "../control/reviews.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { publicationBranch } from "../publication/publisher.js";
import { planDelivery } from "../publication/delivery.js";
import {
  bindValidationToPublishedHead,
  type ExactHeadValidationEvidence,
} from "../validation/plan.js";
import type { RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim, type RecoveryClaimRecord } from "./claims.js";
import {
  loadRecoveryPlan,
  recoveryPlanDigest,
  recoveryPlanBindingDigest,
  type RecoveryPlanRecord,
} from "./plan.js";
import { observeRecoveryNativeTransition } from "./native-transition.js";
import {
  createRecoveryEventDigest,
  recoveryEventDigest,
  recoverySourceEventsDigest,
} from "./identity.js";
import { recoveryAdoptionEvents } from "./transaction.js";

export type RecoverySourcePublishedEvent = Extract<
  FactoryEvent,
  { event: "RecoverySourcePublished" }
>;
/** A view of receipt identities, not a relabelled protocol event or a modified plan. */
export function recoverySourcePublicationBinding(
  event: RecoverySourcePublishedEvent,
  repository: string,
) {
  return {
    receiptDigest: recoveryEventDigest(event),
    mode: event.mode,
    pullRequest: event.pullRequest,
    pullRequestNodeId: event.pullRequestNodeId,
    branch: event.branch,
    baseBranch: event.baseBranch,
    baseSha: event.sourceBaseSha,
    headSha: event.sourceHeadSha,
    baseRepository: repository,
    headRepository: repository,
    stackNumber: event.stackNumber ?? null,
  };
}
type Input = {
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  events: readonly FactoryEvent[];
  store: RecoveryReadStore;
  workItem: number;
};
export interface RecoverySourceArtifactProof {
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  workItem: number;
  branch: string;
  headSha: string;
  exactHeadValidation: ExactHeadValidationEvidence;
  /** Immutable compilation topology, not a claim of native linkage. */
  delivery: {
    unitId: string;
    itemId: string;
    position: number;
    parentItemId?: string;
    stack: boolean;
  };
}
function requireEvidence(value: unknown): asserts value {
  if (!value) throw new Error("source artifact publication evidence unavailable");
}

/** Verify the acknowledged Git artifact directly; never rerun a worker or reconstruct missing bytes. */
export async function loadRecoverySourceArtifact(
  input: Input,
  recordedPublication?: RecoverySourcePublishedEvent,
): Promise<RecoverySourceArtifactProof> {
  const recoveryEventDigest = createRecoveryEventDigest();
  requireEvidence(input.events.length <= 10000);
  const events = [
    ...new Map(
      input.events.map((value) => {
        const event = parseFactoryEvent(value);
        return [recoveryEventDigest(event), event] as const;
      }),
    ).values(),
  ];
  requireEvidence(new Set(events.map((event) => event.sequence)).size === events.length);
  const record = await loadRecoveryPlan(
    input.store,
    input.planRecord.plan.objective,
    input.planRecord.digest,
  );
  requireEvidence(
    record &&
      record.digest === recoveryPlanDigest(input.planRecord.plan) &&
      record.commitOid === input.planRecord.commitOid &&
      record.blobOid === input.planRecord.blobOid &&
      record.ref === input.planRecord.ref,
  );
  const plan = record.plan;
  const claim = await loadRecoveryClaim(input.store, plan.objective, plan.predecessor.runId);
  requireEvidence(
    claim &&
      claim.oid === input.claim.oid &&
      claim.blobOid === input.claim.blobOid &&
      claim.planDigest === record.digest,
  );
  requireEvidence(events.every((event) => event.objective === plan.objective));
  const requests = events.filter(
    (event) => event.event === "RecoveryRequested" && event.requestId === plan.requestId,
  );
  const starts = events.filter(
    (event) => event.event === "FactoryRunStarted" && event.runId === plan.predecessor.runId,
  );
  requireEvidence(
    requests.length === 1 &&
      requests[0]!.event === "RecoveryRequested" &&
      starts.length === 1 &&
      starts[0]!.event === "FactoryRunStarted",
  );
  for (const expected of recoveryAdoptionEvents({
    planRecord: record,
    claim,
    authenticatedRequest: requests[0]!,
    predecessorStart: starts[0]!,
  })) {
    const expectedDigest = recoveryEventDigest(expected);
    requireEvidence(events.some((event) => recoveryEventDigest(event) === expectedDigest));
  }
  requireEvidence(
    recoverySourceEventsDigest({
      objective: plan.objective,
      runIds: plan.history.map((entry) => entry.runId),
      events,
      maxSequence: Number.MAX_SAFE_INTEGER,
    }) === plan.sourceEventsDigest,
  );
  const item = plan.items.find((item) => item.workItem === input.workItem);
  const source = item?.source;
  requireEvidence(
    item &&
      ["reuse-artifact", "revalidate"].includes(item.action) &&
      source &&
      !source.publication &&
      source.artifactHead &&
      source.artifactDigest &&
      source.validation &&
      source.review,
  );
  const exact = (digest: string) => {
    const event = events.find((event) => recoveryEventDigest(event) === digest);
    requireEvidence(event);
    return event;
  };
  const same = (event: FactoryEvent) =>
    event.runId === source.runId &&
    "workItem" in event &&
    event.workItem === item.workItem &&
    "attempt" in event &&
    event.attempt === source.attempt;
  const reserved = exact(source.reservationReceiptDigest);
  requireEvidence(
    reserved.event === "AttemptReserved" &&
      same(reserved) &&
      reserved.policyDigest ===
        plan.history.find((entry) => entry.runId === source.runId)?.policyDigest &&
      source.reservationRef === attemptRef(plan.objective, item.workItem, source.attempt) &&
      (await input.store.readRef(source.reservationRef)) === source.reservationCommitOid,
  );
  const reservation = await input.store.readCommit(source.reservationCommitOid);
  const trailer = decodeEventTrailer(reservation.message);
  requireEvidence(
    reservation.oid === source.reservationCommitOid &&
      trailer &&
      recoveryEventDigest(trailer) === source.reservationReceiptDigest &&
      reservation.parentOids.length === 1 &&
      reservation.parentOids[0] === reserved.baseSha &&
      (await input.store.readCommit(reserved.baseSha)).treeOid === reservation.treeOid,
  );
  const validation = exact(source.validation.receiptDigest);
  requireEvidence(
    validation.kind === "validation" &&
      same(validation) &&
      validation.passed &&
      validation.baseSha === source.validation.baseSha &&
      validation.outputTreeSha === source.validation.outputTreeSha &&
      validation.evidenceDigest === source.validation.evidenceDigest,
  );
  const { branch, headSha, treeSha } = source.artifactHead;
  let publishedHeadObserved = false;
  if (
    recordedPublication &&
    events.some((event) => recoveryEventDigest(event) === recoveryEventDigest(recordedPublication))
  ) {
    requireEvidence(
      recordedPublication.runId === plan.successorRunId &&
        recordedPublication.planDigest === record.digest &&
        recordedPublication.workItem === input.workItem &&
        recordedPublication.sourceRunId === source.runId &&
        recordedPublication.sourceAttempt === source.attempt &&
        recordedPublication.sourceHeadSha === headSha &&
        recordedPublication.branch === branch &&
        recordedPublication.sourceReservationReceiptDigest === source.reservationReceiptDigest,
    );
    const pull = await input.store.readPullRequest(recordedPublication.pullRequest);
    requireEvidence(
      pull.nodeId === recordedPublication.pullRequestNodeId &&
        pull.headRef === branch &&
        pull.baseRepository?.toLowerCase() === plan.repository.toLowerCase() &&
        pull.headRepository?.toLowerCase() === plan.repository.toLowerCase(),
    );
    if (pull.headSha !== headSha || pull.baseRef !== recordedPublication.baseBranch)
      await observeRecoveryNativeTransition({
        planRecord: record,
        events,
        store: input.store,
        workItem: input.workItem,
      });
    publishedHeadObserved = true;
  }
  requireEvidence(
    branch === publicationBranch(plan.objective, item.workItem, source.attempt) &&
      (publishedHeadObserved || (await input.store.readRef(`refs/heads/${branch}`)) === headSha),
  );
  const head = await input.store.readCommit(headSha);
  requireEvidence(
    head.oid === headSha &&
      head.treeOid === treeSha &&
      treeSha === validation.outputTreeSha &&
      head.parentOids.length === 1 &&
      head.parentOids[0] === validation.baseSha &&
      head.message.split(/\r?\n/).includes(`Factory-Artifact: ${source.artifactDigest}`) &&
      head.message.split(/\r?\n/).includes(`Factory-Validation: ${validation.evidenceDigest}`),
  );
  const review = await loadReviewCheckpoint(input.store, {
    kind: "artifact",
    runId: source.runId,
    objective: plan.objective,
    workItem: item.workItem,
    attempt: source.attempt,
    artifactDigest: source.artifactDigest,
    baseSha: validation.baseSha,
    outputTreeSha: validation.outputTreeSha,
    evidenceDigest: validation.evidenceDigest,
  });
  requireEvidence(
    review &&
      review.ref === source.review.ref &&
      review.commitOid === source.review.commitOid &&
      review.blobOid === source.review.blobOid &&
      review.identityDigest === source.review.identityDigest &&
      review.review.accepted &&
      !review.review.unmetCriteria.length,
  );
  const accepted = events.filter(
    (event) =>
      same(event) &&
      event.event === "AttemptValidated" &&
      event.artifactDigest === source.artifactDigest,
  );
  requireEvidence(accepted.length > 0);
  const usage = events.filter(
    (event) =>
      same(event) &&
      event.kind === "budget" &&
      event.event === "BudgetReconciled" &&
      event.phase === "management" &&
      event.unit === "model_tokens" &&
      event.usageId === `review-${review.identityDigest}`,
  );
  requireEvidence(
    usage.length > 0 &&
      usage.every(
        (event) =>
          event.amount === review.usage.inputTokens + review.usage.outputTokens &&
          event.sequence < accepted[0]!.sequence,
      ),
  );
  const graph = await loadCompiledGraph(input.store, plan.objective, plan.graph.sourceRunId);
  requireEvidence(
    graph &&
      graph.commitOid === plan.graph.commitOid &&
      graph.blobOid === plan.graph.blobOid &&
      graph.graphDigest === plan.graph.digest,
  );
  const projection = await loadCompiledGraphProjection(
    input.store,
    plan.objective,
    plan.graph.sourceRunId,
    graph,
  );
  requireEvidence(
    projection &&
      projection.commitOid === plan.graph.projection.commitOid &&
      projection.blobOid === plan.graph.projection.blobOid &&
      recoveryPlanBindingDigest(
        projection.bindings.map((binding) => ({
          compilerId: binding.compilerId,
          issueNodeId: binding.issueNodeId,
          workItem: binding.issueNumber,
        })),
      ) === plan.graph.projection.bindingDigest,
  );
  let delivery: RecoverySourceArtifactProof["delivery"] = {
    unitId: `delivery/${item.compilerId}`,
    itemId: item.compilerId,
    position: 0,
    stack: false,
  };
  if (plan.acceptedPolicy.delivery?.mode === "stacked-prs") {
    const topology = planDelivery(
      graph.objective.workItems.map((entry) => {
        requireEvidence(entry.delivery);
        return {
          id: entry.id,
          dependsOn: entry.dependsOn,
          delivery: {
            group: entry.delivery.group,
            relationship: entry.delivery.relationship,
            ...(entry.delivery.parentWorkItem
              ? { parentWorkItem: entry.delivery.parentWorkItem }
              : {}),
          },
        };
      }),
    );
    requireEvidence(topology.result === "supported");
    const member = topology.items.find((member) => member.itemId === item.compilerId);
    requireEvidence(member);
    delivery = {
      unitId: member.unitId,
      itemId: member.itemId,
      position: member.position,
      ...(member.parentItemId ? { parentItemId: member.parentItemId } : {}),
      stack: topology.units.find((unit) => unit.id === member.unitId)?.kind === "stack",
    };
  }
  return {
    planRecord: record,
    claim,
    workItem: item.workItem,
    branch,
    headSha,
    delivery,
    exactHeadValidation: bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: validation.evidenceDigest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
      },
      publishedBaseSha: validation.baseSha,
      publishedHeadSha: headSha,
      publishedTreeSha: head.treeOid,
    }),
  };
}

/** Construction is descriptive only; verify the independent PR before recording it. */
export function createRecoverySourcePublishedEvent(input: {
  artifact: RecoverySourceArtifactProof;
  pullRequest: number;
  pullRequestNodeId: string;
  baseBranch: string;
  mode: "regular-prs" | "native-stacks";
  stackNumber?: number;
  sequence: number;
  at: string;
}): RecoverySourcePublishedEvent {
  const { artifact } = input;
  const plan = artifact.planRecord.plan;
  const source = plan.items.find((item) => item.workItem === artifact.workItem)!.source!;
  const event = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "recovery",
    event: "RecoverySourcePublished",
    objective: plan.objective,
    runId: plan.successorRunId,
    sequence: input.sequence,
    at: input.at,
    recoveryRequestId: plan.requestId,
    planDigest: artifact.planRecord.digest,
    claimRef: artifact.claim.ref,
    claimOid: artifact.claim.oid,
    workItem: artifact.workItem,
    sourceRunId: source.runId,
    sourceAttempt: source.attempt,
    sourceReservationRef: source.reservationRef,
    sourceReservationCommitOid: source.reservationCommitOid,
    sourceReservationReceiptDigest: source.reservationReceiptDigest,
    sourceHeadSha: artifact.headSha,
    sourceBaseSha: source.validation!.baseSha,
    sourceTreeSha: source.validation!.outputTreeSha,
    sourceArtifactDigest: source.artifactDigest,
    sourceValidationDigest: source.validation!.evidenceDigest,
    sourceReviewIdentityDigest: source.review!.identityDigest,
    branch: artifact.branch,
    baseBranch: input.baseBranch,
    pullRequest: input.pullRequest,
    pullRequestNodeId: input.pullRequestNodeId,
    mode: input.mode,
    unitId: artifact.delivery.unitId,
    itemId: artifact.delivery.itemId,
    position: input.mode === "native-stacks" ? artifact.delivery.position : 0,
    ...(input.mode === "native-stacks" && artifact.delivery.parentItemId
      ? { parentItemId: artifact.delivery.parentItemId }
      : {}),
    ...(input.stackNumber ? { stackNumber: input.stackNumber } : {}),
    exactHeadValidationDigest: artifact.exactHeadValidation.digest,
  });
  requireEvidence(event.event === "RecoverySourcePublished");
  return event;
}

export async function verifyRecoverySourcePublication(
  input: Omit<Input, "workItem"> & { publication: RecoverySourcePublishedEvent },
): Promise<
  | {
      status: "verified";
      publication: RecoverySourcePublishedEvent;
      artifact: RecoverySourceArtifactProof;
      current: "unchanged" | "native-transition-observed";
      executionAuthorized: false;
    }
  | { status: "blocked"; blockers: string[]; executionAuthorized: false }
> {
  const recoveryEventDigest = createRecoveryEventDigest();
  try {
    const event = parseFactoryEvent(input.publication);
    requireEvidence(event.event === "RecoverySourcePublished");
    const recorded = input.events.some(
      (value) => recoveryEventDigest(value) === recoveryEventDigest(event),
    );
    const artifact = await loadRecoverySourceArtifact(
      { ...input, workItem: event.workItem },
      recorded ? event : undefined,
    );
    const expected = createRecoverySourcePublishedEvent({
      artifact,
      pullRequest: event.pullRequest,
      pullRequestNodeId: event.pullRequestNodeId,
      baseBranch: event.baseBranch,
      mode: event.mode,
      ...(event.stackNumber ? { stackNumber: event.stackNumber } : {}),
      sequence: event.sequence,
      at: event.at,
    });
    requireEvidence(
      recoveryEventDigest(event) === recoveryEventDigest(expected) &&
        event.sequence > artifact.claim.transaction.startSequence + 2,
    );
    const selection = input.events.filter(
      (value) => value.kind === "delivery" && value.runId === event.runId,
    );
    requireEvidence(
      selection.length === 1 &&
        selection[0]!.kind === "delivery" &&
        selection[0]!.selected === event.mode &&
        selection[0]!.sequence < event.sequence,
    );
    requireEvidence(
      !input.events.some(
        (value) =>
          (value.sequence === event.sequence ||
            (value.event === "RecoverySourcePublished" &&
              value.runId === event.runId &&
              value.workItem === event.workItem)) &&
          recoveryEventDigest(value) !== recoveryEventDigest(event),
      ),
    );
    const pull = await input.store.readPullRequest(event.pullRequest);
    const changed = pull.headSha !== event.sourceHeadSha || pull.baseRef !== event.baseBranch;
    if (changed) {
      requireEvidence(recorded && event.mode === "native-stacks" && artifact.delivery.stack);
      await observeRecoveryNativeTransition({
        planRecord: artifact.planRecord,
        events: input.events,
        store: input.store,
        workItem: event.workItem,
      });
    }
    requireEvidence(
      pull.nodeId === event.pullRequestNodeId &&
        pull.number === event.pullRequest &&
        pull.headRef === event.branch &&
        pull.baseRepository?.toLowerCase() === artifact.planRecord.plan.repository.toLowerCase() &&
        pull.headRepository?.toLowerCase() === artifact.planRecord.plan.repository.toLowerCase() &&
        (pull.state === "open" || pull.merged),
    );
    if (event.mode === "native-stacks") {
      requireEvidence(artifact.planRecord.plan.acceptedPolicy.delivery?.mode === "stacked-prs");
      if (artifact.delivery.stack) {
        if (event.stackNumber) {
          requireEvidence(input.store.readStack);
          const stack = await input.store.readStack(event.stackNumber);
          const member = stack.pullRequests.find((value) => value.number === event.pullRequest);
          requireEvidence(
            member &&
              member.number === event.pullRequest &&
              member.headSha === pull.headSha &&
              member.headRef === event.branch &&
              member.baseRef === pull.baseRef,
          );
        } else {
          // A singleton retained root is published before its fresh child exists.
          // This proves a PR, not native membership or permission to merge it.
          requireEvidence(
            artifact.delivery.position === 0 &&
              !artifact.delivery.parentItemId &&
              !changed &&
              event.baseBranch === artifact.planRecord.plan.baseBranch &&
              (pull.merged || pull.baseSha === artifact.exactHeadValidation.baseSha),
          );
        }
      } else
        requireEvidence(
          !event.stackNumber && event.baseBranch === artifact.planRecord.plan.baseBranch,
        );
    } else
      requireEvidence(
        event.baseBranch === artifact.planRecord.plan.baseBranch &&
          (!artifact.delivery.stack ||
            artifact.planRecord.plan.acceptedPolicy.delivery?.onUnavailable === "regular-prs"),
      );
    return {
      status: "verified",
      publication: event,
      artifact,
      current: changed ? "native-transition-observed" : "unchanged",
      executionAuthorized: false,
    };
  } catch {
    return {
      status: "blocked",
      blockers: ["source-publication-unverified"],
      executionAuthorized: false,
    };
  }
}
