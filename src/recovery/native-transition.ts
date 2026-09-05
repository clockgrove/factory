import { loadCompiledGraph } from "../control/graphs.js";
import type { FactoryEvent } from "../protocol/events.js";
import { planDelivery } from "../publication/delivery.js";
import type { RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim } from "./claims.js";
import { recoveryEventDigest } from "./identity.js";
import { loadRecoveryPlan, type RecoveryPlanRecord } from "./plan.js";
import { verifyRecoverySourceIntegration } from "./outcomes.js";
import { nativePublicationStackNumber } from "./native-source-stacks.js";

function requireTransition(value: unknown): asserts value {
  if (!value) throw new Error("native source transition evidence unavailable");
}

/** Recognize only a tree-preserving provider rebase after this successor's exact
 * lower-layer integration. This observation is NOT new-head validation or merge
 * authority: independently persisted candidate validation/review remain required.
 */
export async function observeRecoveryNativeTransition(input: {
  planRecord: RecoveryPlanRecord;
  events: readonly FactoryEvent[];
  store: RecoveryReadStore;
  workItem: number;
}): Promise<{
  sourceHeadSha: string;
  deliveryHeadSha: string;
  targetBaseSha: string;
  outputTreeSha: string;
  stackNumber: number;
  lowerOutcomeDigest: string;
}> {
  requireTransition(input.events.length <= 10_000);
  const record = await loadRecoveryPlan(
    input.store,
    input.planRecord.plan.objective,
    input.planRecord.digest,
  );
  requireTransition(
    record &&
      record.commitOid === input.planRecord.commitOid &&
      record.blobOid === input.planRecord.blobOid,
  );
  const plan = record.plan;
  requireTransition(plan.acceptedPolicy.delivery?.mode === "stacked-prs");
  const item = plan.items.find((entry) => entry.workItem === input.workItem);
  const source = item?.source;
  requireTransition(source?.validation);
  const publications = input.events.filter(
    (event) =>
      event.event === "RecoverySourcePublished" &&
      event.runId === plan.successorRunId &&
      event.workItem === item!.workItem,
  );
  const restored = publications[0];
  requireTransition(publications.length <= 1);
  const publication =
    source.publication ??
    (restored?.event === "RecoverySourcePublished"
      ? {
          mode: restored.mode,
          pullRequest: restored.pullRequest,
          pullRequestNodeId: restored.pullRequestNodeId,
          headSha: restored.sourceHeadSha,
          branch: restored.branch,
          stackNumber: restored.stackNumber ?? null,
        }
      : null);
  const original = source.publication
    ? input.events.find((event) => recoveryEventDigest(event) === source.publication!.receiptDigest)
    : null;
  const stackNumber =
    original?.kind === "publication"
      ? nativePublicationStackNumber(original, input.events)
      : publication?.stackNumber;
  requireTransition(publication?.mode === "native-stacks" && stackNumber && input.store.readStack);
  if (!source.publication)
    requireTransition(
      restored?.event === "RecoverySourcePublished" &&
        restored.planDigest === record.digest &&
        restored.sourceRunId === source.runId &&
        restored.sourceAttempt === source.attempt &&
        restored.sourceHeadSha === source.artifactHead?.headSha &&
        restored.sourceValidationDigest === source.validation.evidenceDigest &&
        restored.sourceReservationReceiptDigest === source.reservationReceiptDigest,
    );
  const graph = await loadCompiledGraph(input.store, plan.objective, plan.graph.sourceRunId);
  requireTransition(
    graph &&
      graph.commitOid === plan.graph.commitOid &&
      graph.blobOid === plan.graph.blobOid &&
      graph.graphDigest === plan.graph.digest,
  );
  const topology = planDelivery(
    graph.objective.workItems.map((entry) => {
      requireTransition(entry.delivery);
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
  requireTransition(topology.result === "supported");
  const member = topology.items.find((entry) => entry.itemId === item!.compilerId);
  const unit = topology.units.find((entry) => entry.id === member?.unitId);
  requireTransition(
    unit?.kind === "stack" &&
      member &&
      member.position > 0 &&
      member.parentItemId === unit.items[member.position - 1],
  );
  const parent = plan.items.find((entry) => entry.compilerId === member.parentItemId);
  requireTransition(
    parent?.source &&
      source.validation.baseSha ===
        (parent.source.publication?.headSha ?? parent.source.artifactHead?.headSha),
  );
  const lower = input.events.filter(
    (event) =>
      event.event === "RecoverySourceIntegrated" &&
      event.runId === plan.successorRunId &&
      event.workItem === parent.workItem,
  );
  requireTransition(lower.length === 1 && lower[0]!.event === "RecoverySourceIntegrated");
  const claim = await loadRecoveryClaim(input.store, plan.objective, plan.predecessor.runId);
  requireTransition(claim);
  const lowerProof = await verifyRecoverySourceIntegration({
    planRecord: record,
    claim,
    events: input.events,
    store: input.store,
    outcome: lower[0]!,
  });
  requireTransition(lowerProof.status === "verified");
  const pull = await input.store.readPullRequest(publication.pullRequest);
  requireTransition(
    pull.number === publication.pullRequest &&
      pull.nodeId === publication.pullRequestNodeId &&
      pull.headRef === publication.branch &&
      pull.baseRef === plan.baseBranch &&
      pull.baseRepository?.toLowerCase() === plan.repository.toLowerCase() &&
      pull.headRepository?.toLowerCase() === plan.repository.toLowerCase() &&
      (pull.state === "open" || pull.merged),
  );
  const targetBaseSha = lowerProof.outcome.mergeCommitSha;
  requireTransition(pull.baseSha === targetBaseSha);
  const originalHead = await input.store.readCommit(publication.headSha);
  const head = await input.store.readCommit(pull.headSha);
  requireTransition(
    originalHead.oid === publication.headSha &&
      originalHead.treeOid === source.validation.outputTreeSha &&
      head.oid === pull.headSha &&
      head.parentOids.length === 1 &&
      head.parentOids[0] === targetBaseSha &&
      head.treeOid === originalHead.treeOid,
  );
  const stack = await input.store.readStack(stackNumber);
  const current = stack.pullRequests.find((entry) => entry.number === publication.pullRequest);
  requireTransition(
    stack.number === stackNumber &&
      stack.baseRef === plan.baseBranch &&
      current &&
      current.headSha === pull.headSha &&
      current.headRef === publication.branch &&
      current.baseRef === plan.baseBranch &&
      current.baseSha === targetBaseSha,
  );
  return {
    sourceHeadSha: publication.headSha,
    deliveryHeadSha: pull.headSha,
    targetBaseSha,
    outputTreeSha: head.treeOid,
    stackNumber: stack.number,
    lowerOutcomeDigest: recoveryEventDigest(lowerProof.outcome),
  };
}
