import type { FactoryReadSnapshot } from "../application/status.js";
import type { FactoryEvent } from "../protocol/events.js";
import type { RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim } from "./claims.js";
import { recoveryClaimRef, recoverySourceEventsDigest } from "./identity.js";
import { loadRecoveryPlan, type RecoveryPlanRecord } from "./plan.js";
import { loadRecoveryRuntime, type RecoveryRuntime } from "./runtime.js";

function requireHistory(condition: unknown): asserts condition {
  if (!condition) throw new Error("historical recovery runtime binding unavailable");
}

/**
 * Verify each adopted run at its explicitly acknowledged next-plan fence. The
 * latest runtime is always loaded from the complete current snapshot first.
 * Historical partitions prove graph/reservation/capacity provenance only: their
 * accounting and resource state must never replace complete current observations.
 */
export async function loadHistoricalRecoveryRuntimes(input: {
  snapshot: FactoryReadSnapshot;
  historyComplete: boolean;
  store: RecoveryReadStore;
  latestRunId: string;
}): Promise<ReadonlyMap<string, RecoveryRuntime>> {
  requireHistory(input.historyComplete);
  const latest = await loadRecoveryRuntime({
    objective: input.snapshot.number,
    runId: input.latestRunId,
    store: input.store,
    readSnapshot: async () => ({ snapshot: input.snapshot, historyComplete: true }),
  });
  requireHistory(latest.status === "verified");
  const runtimes = new Map<string, RecoveryRuntime>([[input.latestRunId, latest]]);
  const records: RecoveryPlanRecord[] = [latest.planRecord];
  const seen = new Set([latest.planRecord.digest]);
  let next = latest.planRecord;
  while (next.plan.priorPlanDigest !== null) {
    requireHistory(records.length < 100 && !seen.has(next.plan.priorPlanDigest));
    const record = await loadRecoveryPlan(
      input.store,
      input.snapshot.number,
      next.plan.priorPlanDigest,
    );
    requireHistory(
      record &&
        record.digest === next.plan.priorPlanDigest &&
        record.plan.successorRunId === next.plan.predecessor.runId &&
        record.plan.repositoryId === next.plan.repositoryId &&
        record.plan.objectiveNodeId === next.plan.objectiveNodeId &&
        record.plan.history.length + 1 === next.plan.history.length &&
        record.plan.history.every(
          (entry, index) => entry.runId === next.plan.history[index]?.runId,
        ),
    );
    seen.add(record.digest);
    records.push(record);
    next = record;
  }

  // Read actual claims again; only exact claims in this independently verified
  // accepted chain may be excluded from an older runtime's historical read view.
  const claimPrefix = `refs/clockgrove-factory/recovery-claims/objective-${input.snapshot.number}/`;
  const claimObservations = await input.store.listRefs(claimPrefix);
  requireHistory(
    claimObservations.length === records.length &&
      new Set(claimObservations.map((entry) => entry.ref)).size === claimObservations.length,
  );
  const knownClaims = new Map<string, string>();
  for (const record of records) {
    const claim = await loadRecoveryClaim(
      input.store,
      input.snapshot.number,
      record.plan.predecessor.runId,
    );
    requireHistory(
      claim &&
        claim.planDigest === record.digest &&
        claim.successorRunId === record.plan.successorRunId &&
        claim.requestId === record.plan.requestId &&
        claimObservations.some((entry) => entry.ref === claim.ref && entry.oid === claim.oid),
    );
    knownClaims.set(claim.ref, claim.oid);
  }
  for (let index = 1; index < records.length; index++) {
    const record = records[index]!;
    const following = records[index - 1]!;
    const cutoff = following.plan.sourceEventMaxSequence;
    const allowedRuns = new Set([
      ...record.plan.history.map((entry) => entry.runId),
      record.plan.successorRunId,
    ]);
    requireHistory(
      following.plan.history.length === allowedRuns.size &&
        following.plan.history.every((entry) => allowedRuns.has(entry.runId)) &&
        recoverySourceEventsDigest({
          objective: input.snapshot.number,
          runIds: following.plan.history.map((entry) => entry.runId),
          events: latest.events,
          maxSequence: cutoff,
        }) === following.plan.sourceEventsDigest,
    );
    const prefix = (events: readonly FactoryEvent[]) =>
      events.filter((event) => event.sequence <= cutoff);
    const historicalEvents = prefix(latest.events);
    requireHistory(historicalEvents.every((event) => allowedRuns.has(event.runId)));
    const historicalClaimRefs = new Set(
      records
        .slice(index)
        .map((entry) => recoveryClaimRef(input.snapshot.number, entry.plan.predecessor.runId)),
    );
    const listRefs: RecoveryReadStore["listRefs"] = async (requestedPrefix) => {
      const observed = await input.store.listRefs(requestedPrefix);
      if (requestedPrefix !== claimPrefix) return observed;
      requireHistory(
        observed.length === knownClaims.size &&
          new Set(observed.map((entry) => entry.ref)).size === observed.length &&
          observed.every((entry) => knownClaims.get(entry.ref) === entry.oid),
      );
      return observed.filter((entry) => historicalClaimRefs.has(entry.ref));
    };
    const store = new Proxy(input.store, {
      get(target, property) {
        if (property === "listRefs") return listRefs;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const snapshot: FactoryReadSnapshot = {
      ...input.snapshot,
      factoryEvents: prefix(input.snapshot.factoryEvents ?? []),
      workItems: input.snapshot.workItems.map((item) => ({
        ...item,
        factoryEvents: prefix(item.factoryEvents ?? []),
      })),
    };
    const runtime = await loadRecoveryRuntime({
      objective: input.snapshot.number,
      runId: record.plan.successorRunId,
      store,
      readSnapshot: async () => ({ snapshot, historyComplete: true }),
    });
    requireHistory(runtime.status === "verified" && runtime.planRecord.digest === record.digest);
    runtimes.set(record.plan.successorRunId, runtime);
  }
  return runtimes;
}
