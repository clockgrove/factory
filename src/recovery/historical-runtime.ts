import type { FactoryReadSnapshot } from "../application/status.js";
import { hasCurrentWriterAuthority } from "../control/receipts.js";
import type { RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim } from "./claims.js";
import {
  recoveryClaimRef,
  recoverySourceEventsDigest,
  type RecoveryEventObservation,
} from "./identity.js";
import { loadRecoveryPlan, type RecoveryPlanRecord } from "./plan.js";
import {
  loadRecoveryRuntime,
  type RecoveryGraphBootstrapRuntime,
  type RecoveryRuntime,
  type RecoveryRuntimeResult,
} from "./runtime.js";

function requireHistory(condition: unknown): asserts condition {
  if (!condition) throw new Error("historical recovery runtime binding unavailable");
}

export class HistoricalRecoveryRuntimeError extends Error {
  constructor(
    readonly blockerCode:
      | "historical-runtime-authentication"
      | "historical-graph-bootstrap-unsupported",
    message: string,
  ) {
    super(message);
    this.name = "HistoricalRecoveryRuntimeError";
  }
}

type AuthenticatedHistoricalRuntime = RecoveryRuntime | RecoveryGraphBootstrapRuntime;

async function authenticateHistoricalRuntime(
  runtime: RecoveryRuntimeResult,
  store: RecoveryReadStore,
): Promise<AuthenticatedHistoricalRuntime> {
  if (runtime.status === "blocked")
    throw new HistoricalRecoveryRuntimeError(
      "historical-runtime-authentication",
      "A historical successor runtime failed plan, claim, adoption, or source-evidence authentication; re-observe its durable evidence.",
    );
  if (runtime.status !== "graph-bootstrap") return runtime;
  const terminal = runtime.currentEvents.filter((event) =>
    ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(event.event),
  );
  if (
    terminal.length !== 1 ||
    !hasCurrentWriterAuthority(terminal[0]!, runtime.events, runtime.objectiveAuthority) ||
    runtime.currentUnknownModelUsageCount !== 0 ||
    (await store.readRef(runtime.planRecord.plan.graph.ref)) !== null ||
    (await store.readRef(runtime.planRecord.plan.graph.projection.ref)) !== null
  )
    throw new HistoricalRecoveryRuntimeError(
      "historical-graph-bootstrap-unsupported",
      "An authenticated historical graph-bootstrap generation is not safely recoverable: it requires one authoritative terminal, closed management usage, and absent graph and projection refs.",
    );
  return runtime;
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
  eventObservation?: RecoveryEventObservation;
}): Promise<ReadonlyMap<string, AuthenticatedHistoricalRuntime>> {
  requireHistory(input.historyComplete);
  const latestSnapshot = input.eventObservation
    ? {
        ...input.snapshot,
        factoryEvents: [...input.eventObservation.events],
        workItems: input.snapshot.workItems.map((item) => ({ ...item, factoryEvents: [] })),
      }
    : input.snapshot;
  const latest = await authenticateHistoricalRuntime(
    await loadRecoveryRuntime({
      objective: input.snapshot.number,
      runId: input.latestRunId,
      store: input.store,
      readSnapshot: async () => ({
        snapshot: latestSnapshot,
        historyComplete: true,
        ...(input.eventObservation ? { eventObservation: input.eventObservation } : {}),
      }),
    }),
    input.store,
  );
  const runtimes = new Map<string, AuthenticatedHistoricalRuntime>([[input.latestRunId, latest]]);
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
          events: latest.eventObservation,
          maxSequence: cutoff,
        }) === following.plan.sourceEventsDigest,
    );
    const historicalObservation = latest.eventObservation.select(
      (event) => event.sequence <= cutoff,
    );
    const historicalEvents = historicalObservation.events;
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
    // listRefs is a restricted historical view, including when the input port is frozen.
    const store = new Proxy({} as RecoveryReadStore, {
      get(_target, property) {
        if (property === "listRefs") return listRefs;
        const value = Reflect.get(input.store, property, input.store);
        return typeof value === "function" ? value.bind(input.store) : value;
      },
    });
    const snapshot: FactoryReadSnapshot = {
      ...input.snapshot,
      // Preserve the authenticated view as the sole event source. Recovery
      // verification treats Objective and Work Item streams as one observation.
      factoryEvents: [...historicalEvents],
      workItems: input.snapshot.workItems.map((item) => ({
        ...item,
        factoryEvents: [],
      })),
    };
    const runtime = await authenticateHistoricalRuntime(
      await loadRecoveryRuntime({
        objective: input.snapshot.number,
        runId: record.plan.successorRunId,
        store,
        readSnapshot: async () => ({
          snapshot,
          historyComplete: true,
          eventObservation: historicalObservation,
        }),
      }),
      store,
    );
    requireHistory(runtime.planRecord.digest === record.digest);
    runtimes.set(record.plan.successorRunId, runtime);
  }
  return runtimes;
}
