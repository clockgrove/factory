import type { FactoryReadSnapshot } from "../application/status.js";
import {
  assertAuthenticatedGraphProjection,
  assertSnapshotMatchesCompiledGraph,
} from "../control/graph-evidence.js";
import { loadCompiledGraph, loadCompiledGraphProjection } from "../control/graphs.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { planDelivery } from "../publication/delivery.js";
import type { RecoveryReadStore } from "./assessment.js";
import { verifyRecoveryChain } from "./chain.js";
import { loadRecoveryClaim, type RecoveryClaimRecord } from "./claims.js";
import { recoveryClaimRef, recoveryEventDigest } from "./identity.js";
import { loadRecoveryPlan, type RecoveryPlanRecord } from "./plan.js";
import { verifyRecoveryMergedSource, type RecoveryMergedSourceProof } from "./outcomes.js";
import { recoveryAdoptionEvents } from "./transaction.js";

type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
export interface RecoverySourceReconciliation {
  controllingRun: Start;
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  /** Complete original observations, including all current accounting liabilities. */
  events: readonly FactoryEvent[];
  mergedSources: Array<RecoveryMergedSourceProof & { issueNodeId: string }>;
}
function requireReconciliation(value: unknown): asserts value {
  if (!value) throw new Error("source reconciliation authority or merge evidence unavailable");
}

/**
 * Restricted read context for journaling actual already-completed native merges.
 * This is not an execution runtime, resource-absence proof, or permission to close
 * issues. The caller must hold/recheck both leases, append only a verified actual
 * outcome, and reload the full runtime before any worker, review, or merge.
 */
export async function loadRecoverySourceReconciliation(input: {
  objective: number;
  runId: string;
  planDigest: string;
  requestId: string;
  store: RecoveryReadStore;
  readSnapshot(): Promise<{ snapshot: FactoryReadSnapshot; historyComplete: boolean }>;
}): Promise<RecoverySourceReconciliation> {
  let reads = 0;
  const cache = new Map<string, Promise<unknown>>();
  // The original read-only capability port may be frozen; keep it in the closure.
  const store = new Proxy({} as RecoveryReadStore, {
    get(_target, property) {
      const operation = Reflect.get(input.store, property, input.store);
      if (typeof operation !== "function") return operation;
      return (...args: unknown[]) => {
        const key = JSON.stringify([property, args]);
        const previous = cache.get(key);
        if (previous) return previous;
        requireReconciliation(++reads <= 1024);
        const pending = Promise.resolve().then(() => Reflect.apply(operation, input.store, args));
        cache.set(key, pending);
        return pending;
      };
    },
  });
  const { snapshot, historyComplete } = await input.readSnapshot();
  requireReconciliation(
    historyComplete &&
      snapshot.number === input.objective &&
      !snapshot.closed &&
      Array.isArray(snapshot.factoryEvents) &&
      snapshot.workItems.length <= 100 &&
      snapshot.workItems.every((item) => Array.isArray(item.factoryEvents)),
  );
  const raw = [
    ...snapshot.factoryEvents,
    ...snapshot.workItems.flatMap((item) => item.factoryEvents!),
  ];
  requireReconciliation(
    raw.length <= 10_000 && Buffer.byteLength(JSON.stringify(raw)) <= 16 * 1024 * 1024,
  );
  const events = [
    ...new Map(
      raw.map((value) => {
        const event = parseFactoryEvent(value);
        return [recoveryEventDigest(event), event] as const;
      }),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  requireReconciliation(
    new Set(events.map((event) => event.sequence)).size === events.length &&
      events.every((event) => event.objective === input.objective),
  );
  deduplicateFactoryEvents(events);
  const starts = events.filter((event): event is Start => event.event === "FactoryRunStarted");
  const controllingRun = starts.at(-1);
  requireReconciliation(
    controllingRun &&
      controllingRun.runId === input.runId &&
      controllingRun.recoveryPlanDigest === input.planDigest &&
      controllingRun.recoveryRequestId === input.requestId &&
      !events.some(
        (event) =>
          event.runId === input.runId &&
          ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
            event.event,
          ),
      ),
  );
  const record = await loadRecoveryPlan(store, input.objective, input.planDigest);
  requireReconciliation(
    record &&
      record.plan.successorRunId === input.runId &&
      record.plan.requestId === input.requestId &&
      record.plan.repositoryId === snapshot.repositoryId &&
      record.plan.objectiveNodeId === snapshot.id &&
      record.plan.baseBranch === snapshot.defaultBranch &&
      record.plan.acceptedPolicy.delivery?.mode === "stacked-prs",
  );
  const plan = record.plan;
  const sourceRuns = new Set(plan.history.map((entry) => entry.runId));
  requireReconciliation(
    events.every((event) => sourceRuns.has(event.runId) || event.runId === input.runId),
  );
  const plans: Record<string, RecoveryPlanRecord> = { [record.digest]: record };
  let cursor = plan.priorPlanDigest;
  while (cursor) {
    requireReconciliation(!plans[cursor] && Object.keys(plans).length < 100);
    const prior = await loadRecoveryPlan(store, input.objective, cursor);
    requireReconciliation(prior);
    plans[cursor] = prior;
    cursor = prior.plan.priorPlanDigest;
  }
  const observed = await store.listRefs(
    `refs/clockgrove-factory/recovery-claims/objective-${input.objective}/`,
  );
  requireReconciliation(
    observed.length <= 100 && new Set(observed.map((entry) => entry.ref)).size === observed.length,
  );
  const claims: RecoveryClaimRecord[] = [];
  for (const entry of observed) {
    const source = plan.history.find(
      (source) => recoveryClaimRef(input.objective, source.runId) === entry.ref,
    );
    requireReconciliation(source);
    const claim = await loadRecoveryClaim(store, input.objective, source.runId);
    requireReconciliation(claim && claim.oid === entry.oid);
    claims.push(claim);
  }
  for (const source of plan.history)
    requireReconciliation(
      (await store.readRef(recoveryClaimRef(input.objective, source.runId))) ===
        (claims.find((claim) => claim.predecessorRunId === source.runId)?.oid ?? null),
    );
  const claim = claims.find((value) => value.planDigest === record.digest);
  requireReconciliation(claim);
  for (const linked of Object.values(plans)) {
    const boundClaim = claims.find((value) => value.planDigest === linked.digest);
    const requests = events.filter(
      (event) => event.event === "RecoveryRequested" && event.requestId === linked.plan.requestId,
    );
    const predecessor = starts.find((start) => start.runId === linked.plan.predecessor.runId);
    requireReconciliation(
      boundClaim &&
        requests.length === 1 &&
        requests[0]!.event === "RecoveryRequested" &&
        predecessor,
    );
    const expected = recoveryAdoptionEvents({
      planRecord: linked,
      claim: boundClaim,
      authenticatedRequest: requests[0]!,
      predecessorStart: predecessor,
    });
    requireReconciliation(
      expected.every((envelope) =>
        events.some((event) => recoveryEventDigest(event) === recoveryEventDigest(envelope)),
      ) &&
        events.filter(
          (event) =>
            event.runId === linked.plan.successorRunId &&
            ["FactoryRunStarted", "RecoveryConsumed", "RecoveryAdoptionCompleted"].includes(
              event.event,
            ),
        ).length === 3,
    );
  }
  const chain = verifyRecoveryChain({
    repository: plan.repository,
    repositoryId: plan.repositoryId,
    objective: input.objective,
    objectiveNodeId: plan.objectiveNodeId,
    historyComplete: true,
    events: events.filter((event) => sourceRuns.has(event.runId)),
    plansByDigest: plans,
    claims: claims.filter((value) => value !== claim),
    candidatePlan: plan,
  });
  requireReconciliation(chain.status === "verified");
  const completed = claim.transaction.startSequence + 2;
  requireReconciliation(
    events
      .filter((event) => event.runId === input.runId)
      .every(
        (event) =>
          event.sequence > completed ||
          ["FactoryRunStarted", "RecoveryConsumed", "RecoveryAdoptionCompleted"].includes(
            event.event,
          ),
      ),
  );
  requireReconciliation(
    events
      .filter((event) => event.runId === input.runId && event.sequence > completed)
      .every(
        (event) =>
          event.kind !== "graph" &&
          (event.kind !== "recovery" ||
            event.event === "RecoverySourceIntegrated" ||
            event.event === "RecoverySourcePublished") &&
          event.event !== "ActivationRequested" &&
          event.event !== "ActivationRejected" &&
          (!("policyDigest" in event) || event.policyDigest === plan.policyDigest) &&
          (!("workItem" in event) ||
            event.workItem === undefined ||
            plan.items.some((item) => item.workItem === event.workItem)),
      ),
  );
  const graph = await loadCompiledGraph(store, input.objective, plan.graph.sourceRunId);
  requireReconciliation(
    graph &&
      graph.commitOid === plan.graph.commitOid &&
      graph.blobOid === plan.graph.blobOid &&
      graph.graphDigest === plan.graph.digest,
  );
  const compiled = events.filter(
    (event) => event.event === "GraphCompiled" && event.runId === plan.graph.sourceRunId,
  );
  requireReconciliation(
    compiled.length === 1 &&
      compiled[0]!.event === "GraphCompiled" &&
      compiled[0]!.graphRef === graph.ref &&
      compiled[0]!.graphBlobSha === graph.blobOid &&
      compiled[0]!.graphDigest === graph.graphDigest &&
      compiled[0]!.graphSize === plan.items.length,
  );
  const projection = await loadCompiledGraphProjection(
    store,
    input.objective,
    plan.graph.sourceRunId,
    graph,
  );
  requireReconciliation(
    projection &&
      projection.commitOid === plan.graph.projection.commitOid &&
      projection.blobOid === plan.graph.projection.blobOid,
  );
  requireReconciliation(
    projection.bindings.length === plan.items.length &&
      projection.bindings.every((binding) =>
        plan.items.some(
          (item) =>
            item.compilerId === binding.compilerId &&
            item.workItem === binding.issueNumber &&
            item.issueNodeId === binding.issueNodeId,
        ),
      ),
  );
  assertAuthenticatedGraphProjection(events, input.objective, plan.graph.sourceRunId, projection);
  assertSnapshotMatchesCompiledGraph(
    graph.objective,
    {
      workItems: snapshot.workItems.map((item) => ({
        id: item.id!,
        number: item.number,
        title: item.title!,
        body: item.body ?? null,
        blockedBy: item.blockedBy!,
      })),
    },
    projection.bindings,
  );
  const topology = planDelivery(
    graph.objective.workItems.map((item) => {
      requireReconciliation(item.delivery);
      return {
        id: item.id,
        dependsOn: item.dependsOn,
        delivery: {
          group: item.delivery.group,
          relationship: item.delivery.relationship,
          ...(item.delivery.parentWorkItem ? { parentWorkItem: item.delivery.parentWorkItem } : {}),
        },
      };
    }),
  );
  requireReconciliation(topology.result === "supported");
  const mergedSources: RecoverySourceReconciliation["mergedSources"] = [];
  for (const unit of topology.units) {
    if (unit.kind !== "stack") continue;
    for (const compilerId of unit.items) {
      const item = plan.items.find((item) => item.compilerId === compilerId);
      requireReconciliation(item);
      if (!item.source || item.action === "execute" || item.source.priorDelivery) continue;
      if (
        events.some(
          (event) =>
            event.event === "RecoverySourceIntegrated" &&
            event.runId === input.runId &&
            event.workItem === item.workItem,
        )
      )
        continue;
      const position = unit.items.indexOf(compilerId);
      // An upper source must wait for the real lower outcome to be journaled and
      // re-read. Never feed hypothetical lower receipts into its transition proof.
      if (position > 0) {
        const parent = plan.items.find((item) => item.compilerId === unit.items[position - 1]);
        if (
          !events.some(
            (event) =>
              event.event === "RecoverySourceIntegrated" &&
              event.runId === input.runId &&
              event.workItem === parent?.workItem,
          )
        )
          continue;
      }
      const restored = events.filter(
        (event) =>
          event.event === "RecoverySourcePublished" &&
          event.runId === input.runId &&
          event.workItem === item.workItem,
      );
      requireReconciliation(restored.length <= 1);
      const publication = item.source.publication ?? restored[0];
      if (!publication || !("pullRequest" in publication)) continue;
      requireReconciliation(typeof publication.pullRequest === "number");
      const pull = await store.readPullRequest(publication.pullRequest);
      if (!pull.merged) continue;
      const proof = await verifyRecoveryMergedSource({
        planRecord: record,
        claim,
        events,
        store,
        workItem: item.workItem,
      });
      mergedSources.push({ ...proof, issueNodeId: item.issueNodeId });
    }
  }
  return { controllingRun, planRecord: record, claim, events, mergedSources };
}
