import type { FactoryReadSnapshot } from "../application/status.js";
import { attemptRef } from "../control/attempts.js";
import {
  loadMergeCandidateCheckpoint,
  mergeCandidateIdentityDigest,
} from "../control/merge-candidates.js";
import { bindValidationToPublishedHead } from "../validation/plan.js";
import { deriveBudgetUsage, remainingBudget, type BudgetUsage } from "../control/budget.js";
import {
  loadCompiledGraph,
  loadCompiledGraphProjection,
  type CompiledGraphRecord,
  type CompiledGraphProjectionRecord,
} from "../control/graphs.js";
import { decodeEventTrailer, deduplicateFactoryEvents } from "../control/receipts.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import type { RecoveryAccountingAssessment } from "./accounting.js";
import type { RecoveryReadStore } from "./assessment.js";
import { verifyRecoveryChain } from "./chain.js";
import { loadRecoveryClaim, type RecoveryClaimRecord } from "./claims.js";
import { resolveRecoveryEvidence, type RecoveryEvidenceResolution } from "./evidence.js";
import { recoveryClaimRef, recoveryEventDigest } from "./identity.js";
import { loadRecoveryPlan, type RecoveryPlanRecord } from "./plan.js";
import { recoveryAdoptionEvents } from "./transaction.js";
import {
  verifyRecoverySourcePublication,
  recoverySourcePublicationBinding,
} from "./source-publications.js";
import {
  verifyRecoverySourceIntegration,
  type RecoverySourceIntegrationProof,
} from "./outcomes.js";

type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
type Request = Extract<FactoryEvent, { event: "RecoveryRequested" }>;
type Attempt = Extract<FactoryEvent, { kind: "attempt" }>;
const terminals = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const workerTerminals = new Set([
  "AttemptSucceeded",
  "AttemptFailed",
  "AttemptTimedOut",
  "AttemptCancelled",
  "AttemptDeferred",
]);
const attemptKey = (event: { runId: string; workItem?: unknown; attempt?: unknown }) =>
  JSON.stringify([event.runId, event.workItem, event.attempt]);

export interface RecoveryRuntime {
  status: "verified";
  adoptionVerified: true;
  /** Observation of durable adoption only. Current leases/resource/admission gates remain mandatory. */
  executionAuthorized: false;
  controllingRun: Start;
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  graph: CompiledGraphRecord;
  projection: CompiledGraphProjectionRecord;
  sourceRunIds: readonly string[];
  accountingRunIds: readonly string[];
  /** Original envelopes: no synthetic starts, terminal records, or re-labelled attempts. */
  events: readonly FactoryEvent[];
  currentEvents: readonly FactoryEvent[];
  sourceEvidence: RecoveryEvidenceResolution;
  sourceIntegrations: readonly RecoverySourceIntegrationProof[];
  /** Exact source-bound capacity envelopes independently validated against candidate checkpoints. */
  verifiedSourceCapacity: readonly FactoryEvent[];
  sourcePublications: readonly Extract<
    Awaited<ReturnType<typeof verifyRecoverySourcePublication>>,
    { status: "verified" }
  >[];
  historicalAccounting: RecoveryAccountingAssessment;
  usage: BudgetUsage;
  remaining: ReturnType<typeof remainingBudget>;
  attemptCounts: Array<{ workItem: number; count: number; remaining: number }>;
  /** Complete observed subtotal is not a substitute for missing terminal token counters. */
  currentUnknownModelUsage: Array<{ workItem: number; attempt: number }>;
  currentUnknownModelUsageCount: number;
}
export type RecoveryRuntimeResult =
  | RecoveryRuntime
  | {
      status: "blocked";
      adoptionVerified: false;
      executionAuthorized: false;
      blockers: string[];
    };

class RuntimeBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireRuntime(condition: unknown, code: string): asserts condition {
  if (!condition) throw new RuntimeBindingError(code);
}

function boundedReadStore(store: RecoveryReadStore): RecoveryReadStore {
  let reads = 0;
  const cache = new Map<string, Promise<unknown>>();
  return new Proxy(store, {
    get(target, property, receiver) {
      const operation = Reflect.get(target, property, receiver);
      if (typeof operation !== "function") return operation;
      return (...args: unknown[]) => {
        const key = JSON.stringify([property, args]);
        const previous = cache.get(key);
        if (previous) return previous;
        requireRuntime(++reads <= 1024, "runtime-read-bound");
        const pending = Promise.resolve().then(() => Reflect.apply(operation, target, args));
        cache.set(key, pending);
        return pending;
      };
    },
  });
}

/**
 * Load an already completed adoption and its authenticated execution suffix. The
 * suffix is checked before the historical-only chain verifier receives its exact
 * source partition, and remains present in all cumulative accounting. This is not
 * the pending transaction inspector and never hides execution to permit adoption.
 */
export async function loadRecoveryRuntime(input: {
  objective: number;
  runId: string;
  store: RecoveryReadStore;
  readSnapshot(): Promise<{ snapshot: FactoryReadSnapshot; historyComplete: boolean }>;
}): Promise<RecoveryRuntimeResult> {
  try {
    input = { ...input, store: boundedReadStore(input.store) };
    const { snapshot, historyComplete } = await input.readSnapshot();
    requireRuntime(
      historyComplete &&
        snapshot.number === input.objective &&
        Array.isArray(snapshot.factoryEvents) &&
        snapshot.workItems.length <= 100 &&
        snapshot.workItems.every((item) => Array.isArray(item.factoryEvents)),
      "snapshot-incomplete",
    );
    const raw = [
      ...snapshot.factoryEvents!,
      ...snapshot.workItems.flatMap((item) => item.factoryEvents!),
    ];
    requireRuntime(raw.length <= 10_000, "history-bound");
    // Exact lost-response duplicates are harmless; different envelopes at one sequence are not.
    const unique = new Map<string, FactoryEvent>();
    const sequences = new Map<number, string>();
    for (const value of raw) {
      const event = parseFactoryEvent(value);
      requireRuntime(
        event.objective === input.objective && Number.isSafeInteger(event.sequence),
        "event-scope-mismatch",
      );
      const digest = recoveryEventDigest(event);
      requireRuntime(
        !sequences.has(event.sequence) || sequences.get(event.sequence) === digest,
        "event-sequence-conflict",
      );
      sequences.set(event.sequence, digest);
      unique.set(digest, event);
    }
    const events = [...unique.values()].sort((a, b) => a.sequence - b.sequence);
    // Also reject semantically conflicting receipts; retain exact originals for transaction checks.
    deduplicateFactoryEvents(events);
    const starts = events.filter(
      (event): event is Start => event.event === "FactoryRunStarted" && event.runId === input.runId,
    );
    requireRuntime(
      starts.length === 1 && starts[0]!.recoveryPlanDigest,
      "successor-start-unavailable",
    );
    const controllingRun = starts[0]!;
    const record = await loadRecoveryPlan(
      input.store,
      input.objective,
      controllingRun.recoveryPlanDigest!,
    );
    requireRuntime(record && record.plan.successorRunId === input.runId, "plan-unavailable");
    const plan = record.plan;
    requireRuntime(
      snapshot.id === plan.objectiveNodeId &&
        snapshot.repositoryId === plan.repositoryId &&
        snapshot.defaultBranch === plan.baseBranch,
      "scope-binding-mismatch",
    );
    const sourceRunIds = plan.history.map((entry) => entry.runId);
    const sourceIds = new Set(sourceRunIds);
    requireRuntime(
      events.every((event) => sourceIds.has(event.runId) || event.runId === input.runId),
      "unplanned-run-history",
    );
    const requests = events.filter(
      (event): event is Request =>
        event.event === "RecoveryRequested" && event.predecessorRunId === plan.predecessor.runId,
    );
    const predecessor = events.find(
      (event): event is Start =>
        event.event === "FactoryRunStarted" && event.runId === plan.predecessor.runId,
    );
    requireRuntime(requests.length === 1 && predecessor, "authority-unavailable");
    const plans: Record<string, RecoveryPlanRecord> = { [record.digest]: record };
    let prior = plan.priorPlanDigest;
    while (prior !== null) {
      requireRuntime(!plans[prior] && Object.keys(plans).length < 100, "ancestry-bound-or-cycle");
      const loaded = await loadRecoveryPlan(input.store, input.objective, prior);
      requireRuntime(loaded, "prior-plan-unavailable");
      plans[prior] = loaded;
      prior = loaded.plan.priorPlanDigest;
    }
    const refs = await input.store.listRefs(
      `refs/clockgrove-factory/recovery-claims/objective-${input.objective}/`,
    );
    requireRuntime(
      refs.length <= 100 && new Set(refs.map((entry) => entry.ref)).size === refs.length,
      "claim-bound-or-conflict",
    );
    const claims: RecoveryClaimRecord[] = [];
    for (const ref of refs) {
      const entry = plan.history.find(
        (source) => recoveryClaimRef(input.objective, source.runId) === ref.ref,
      );
      requireRuntime(entry, "unplanned-claim");
      const claim = await loadRecoveryClaim(input.store, input.objective, entry.runId);
      requireRuntime(claim && claim.oid === ref.oid, "claim-observation-changed");
      claims.push(claim);
    }
    const claim = claims.find((value) => value.predecessorRunId === plan.predecessor.runId);
    requireRuntime(claim, "claim-unavailable");
    // Verify exact adoption envelopes for every explicitly linked edge, not just the latest start.
    for (const linked of Object.values(plans)) {
      const p = linked.plan;
      const c = claims.find((value) => value.planDigest === linked.digest);
      const r = events.filter(
        (event): event is Request =>
          event.event === "RecoveryRequested" && event.requestId === p.requestId,
      );
      const s = events.find(
        (event): event is Start =>
          event.event === "FactoryRunStarted" && event.runId === p.predecessor.runId,
      );
      requireRuntime(c && r.length === 1 && s, "adoption-authority-unavailable");
      const expected = recoveryAdoptionEvents({
        planRecord: linked,
        claim: c,
        authenticatedRequest: r[0]!,
        predecessorStart: s,
      });
      for (const envelope of expected)
        requireRuntime(
          events.some((event) => recoveryEventDigest(event) === recoveryEventDigest(envelope)),
          "adoption-envelope-missing-or-conflicting",
        );
      requireRuntime(
        events.filter(
          (event) =>
            event.runId === p.successorRunId &&
            (event.event === "FactoryRunStarted" ||
              event.event === "RecoveryConsumed" ||
              event.event === "RecoveryAdoptionCompleted"),
        ).length === 3,
        "adoption-envelope-conflict",
      );
    }
    const completedSequence = claim.transaction.startSequence + 2;
    const currentEvents = events.filter((event) => event.runId === input.runId);
    const suffix = currentEvents.filter((event) => event.sequence > completedSequence);
    requireRuntime(currentEvents.length === suffix.length + 3, "successor-effect-before-adoption");
    const items = new Map(plan.items.map((item) => [item.workItem, item]));
    requireRuntime(
      suffix.every(
        (event) =>
          (event.kind !== "recovery" ||
            event.event === "RecoverySourceIntegrated" ||
            event.event === "RecoverySourcePublished") &&
          event.kind !== "graph" &&
          event.event !== "FactoryRunStarted" &&
          event.event !== "ActivationRequested" &&
          event.event !== "ActivationRejected" &&
          (!("policyDigest" in event) || event.policyDigest === plan.policyDigest) &&
          (!("workItem" in event) ||
            event.workItem === undefined ||
            (typeof event.workItem === "number" && items.has(event.workItem))),
      ),
      "successor-effect-binding-invalid",
    );
    const terminal = suffix.filter((event) => terminals.has(event.event));
    requireRuntime(
      terminal.length <= 1 &&
        (!terminal.length ||
          !suffix.some(
            (event) =>
              event.sequence > terminal[0]!.sequence &&
              (["attempt", "capacity", "validation", "publication", "budget"].includes(
                event.kind,
              ) ||
                event.event === "RecoverySourceIntegrated" ||
                event.event === "RecoverySourcePublished"),
          )),
      "successor-terminal-conflict",
    );
    const currentAttempts = new Map<string, Attempt[]>();
    for (const event of suffix)
      if (event.kind === "attempt") {
        const group = currentAttempts.get(attemptKey(event)) ?? [];
        group.push(event);
        currentAttempts.set(attemptKey(event), group);
      }
    for (const group of currentAttempts.values()) {
      const reserved = group.filter((event) => event.event === "AttemptReserved");
      requireRuntime(reserved.length === 1, "successor-reservation-unavailable");
      const first = reserved[0]!;
      requireRuntime(items.get(first.workItem)?.action === "execute", "successor-action-mismatch");
      requireRuntime(
        group.every(
          (event) =>
            event.sequence >= first.sequence &&
            event.backend === first.backend &&
            event.baseSha === first.baseSha &&
            event.directorEpoch === first.directorEpoch,
        ),
        "successor-attempt-conflict",
      );
      const ref = await input.store.readRef(
        attemptRef(input.objective, first.workItem, first.attempt),
      );
      requireRuntime(ref, "successor-reservation-unavailable");
      const commit = await input.store.readCommit(ref);
      const trailer = decodeEventTrailer(commit.message);
      requireRuntime(
        commit.oid === ref &&
          trailer &&
          recoveryEventDigest(trailer) === recoveryEventDigest(first) &&
          commit.parentOids.length === 1 &&
          commit.parentOids[0] === first.baseSha &&
          (await input.store.readCommit(first.baseSha)).treeOid === commit.treeOid,
        "successor-reservation-binding-invalid",
      );
    }
    const sourcePublications: RecoveryRuntime["sourcePublications"][number][] = [];
    for (const publication of suffix)
      if (publication.event === "RecoverySourcePublished") {
        const proof = await verifyRecoverySourcePublication({
          planRecord: record,
          claim,
          events,
          store: input.store,
          publication,
        });
        requireRuntime(proof.status === "verified", "source-publication-unverified");
        sourcePublications.push(proof);
      }
    const sourceCapacity = new Set<FactoryEvent>();
    for (const event of suffix) {
      if (event.kind !== "capacity" || !event.sourceRunId) continue;
      const source = items.get(event.workItem)?.source;
      const adoptedPublication = sourcePublications.find(
        (proof) => proof.publication.workItem === event.workItem,
      );
      const publication =
        source?.publication ??
        (adoptedPublication
          ? recoverySourcePublicationBinding(adoptedPublication.publication, plan.repository)
          : null);
      requireRuntime(
        source &&
          publication &&
          source.validation &&
          source.runId === event.sourceRunId &&
          source.attempt === event.attempt &&
          items.get(event.workItem)?.action !== "execute",
        "source-capacity-binding-invalid",
      );
      const head = await input.store.readCommit(publication.headSha);
      const proof = bindValidationToPublishedHead({
        validation: {
          passed: true,
          digest: source.validation.evidenceDigest,
          baseSha: source.validation.baseSha,
          outputTreeSha: source.validation.outputTreeSha,
        },
        publishedHeadSha: publication.headSha,
        publishedTreeSha: head.treeOid,
        publishedBaseSha: publication.baseSha,
      });
      requireRuntime(
        event.targetBaseSha &&
          event.targetBaseSha !== source.validation.baseSha &&
          event.backend ===
            `factory/integration-validation-${mergeCandidateIdentityDigest({
              runId: input.runId,
              objective: input.objective,
              workItem: event.workItem,
              attempt: source.attempt,
              pullRequest: publication.pullRequest,
              sourceHeadSha: publication.headSha,
              sourceExactHeadValidationDigest: proof.digest,
              targetBaseSha: event.targetBaseSha,
            })}`,
        "source-capacity-candidate-mismatch",
      );
      requireRuntime(
        event.event !== "CapacityReserved" || event.localScopeBatch,
        "source-capacity-scope-unavailable",
      );
      if (event.localScopeBatch)
        requireRuntime(
          event.localScopeBatch.identity.runId === input.runId &&
            event.localScopeBatch.identity.policyDigest === plan.policyDigest &&
            event.localScopeBatch.identity.repository === plan.repository.toLowerCase(),
          "source-capacity-scope-mismatch",
        );
      if (event.event === "CapacityReconciled") {
        const reserved = [...sourceCapacity].filter(
          (entry) =>
            entry.kind === "capacity" &&
            entry.event === "CapacityReserved" &&
            entry.backend === event.backend &&
            entry.workItem === event.workItem &&
            entry.attempt === event.attempt &&
            entry.sourceRunId === event.sourceRunId,
        );
        requireRuntime(
          reserved.length === 1 &&
            reserved[0]!.kind === "capacity" &&
            reserved[0]!.requestedCpu === event.requestedCpu &&
            reserved[0]!.requestedMemoryMb === event.requestedMemoryMb,
          "source-capacity-reconciliation-mismatch",
        );
        requireRuntime(
          await loadMergeCandidateCheckpoint(input.store, {
            runId: input.runId,
            objective: input.objective,
            workItem: event.workItem,
            attempt: source.attempt,
            pullRequest: publication.pullRequest,
            sourceHeadSha: publication.headSha,
            sourceExactHeadValidationDigest: proof.digest,
            targetBaseSha: event.targetBaseSha!,
          }),
          "source-capacity-completion-unavailable",
        );
      }
      sourceCapacity.add(event);
    }
    requireRuntime(
      suffix.every(
        (event) =>
          !("attempt" in event) ||
          event.attempt === undefined ||
          sourceCapacity.has(event) ||
          currentAttempts.has(attemptKey(event)),
      ),
      "orphan-successor-attempt-effect",
    );
    // This partition is historical assessment only, after the full current suffix was validated above.
    const sourceEvents = events.filter((event) => sourceIds.has(event.runId));
    for (const item of plan.items)
      if (item.source === null)
        requireRuntime(
          !sourceEvents.some(
            (event) =>
              "workItem" in event &&
              event.workItem === item.workItem &&
              ["attempt", "capacity", "validation", "publication"].includes(event.kind),
          ),
          "source-attempt-omitted",
        );
    const chain = verifyRecoveryChain({
      repository: plan.repository,
      repositoryId: plan.repositoryId,
      objective: input.objective,
      objectiveNodeId: plan.objectiveNodeId,
      historyComplete,
      events: sourceEvents,
      plansByDigest: plans,
      claims: claims.filter((value) => value !== claim),
      candidatePlan: plan,
    });
    requireRuntime(
      chain.status === "verified" && chain.accounting?.usage,
      "historical-chain-or-accounting-invalid",
    );
    const sourceEvidence = await resolveRecoveryEvidence({
      planRecord: record,
      claim,
      events,
      store: input.store,
      snapshot,
    });
    // Mutable base/head/resource observations remain explicit consumer gates; never bless their changes here.
    requireRuntime(
      !sourceEvidence.blockers.some(
        (blocker) =>
          [
            "source-plan-or-graph-unavailable",
            "source-history-changed",
            "claim-binding-unavailable",
          ].includes(blocker.code) ||
          (blocker.code === "source-item-unavailable" &&
            items.get(blocker.workItem!)?.source !== null),
      ),
      "source-bindings-unavailable",
    );
    const graph = await loadCompiledGraph(input.store, input.objective, plan.graph.sourceRunId);
    requireRuntime(graph, "graph-unavailable");
    const projection = await loadCompiledGraphProjection(
      input.store,
      input.objective,
      plan.graph.sourceRunId,
      graph,
    );
    requireRuntime(
      projection &&
        graph.commitOid === plan.graph.commitOid &&
        projection.commitOid === plan.graph.projection.commitOid,
      "graph-observation-changed",
    );
    const sourceIntegrations: RecoverySourceIntegrationProof[] = [];
    for (const outcome of suffix)
      if (outcome.event === "RecoverySourceIntegrated") {
        const proof = await verifyRecoverySourceIntegration({
          planRecord: record,
          claim,
          events,
          store: input.store,
          outcome,
        });
        requireRuntime(proof.status === "verified", "source-integration-unverified");
        sourceIntegrations.push(proof);
      }
    const ledger = new Map<string, { reserved: number; reconciled?: number; unit: string }>();
    for (const event of events)
      if (event.kind === "budget") {
        requireRuntime(
          Number.isFinite(event.amount) &&
            event.amount >= 0 &&
            event.amount <= Number.MAX_SAFE_INTEGER &&
            (!["model_tokens", "managed_sessions"].includes(event.unit) ||
              Number.isSafeInteger(event.amount)),
          "unsafe-accounting",
        );
        const key = JSON.stringify([
          event.runId,
          event.workItem,
          event.attempt,
          event.phase,
          event.unit,
          event.usageId ?? "default",
        ]);
        const entry = ledger.get(key) ?? { reserved: 0, unit: event.unit };
        if (event.event === "BudgetReserved") entry.reserved += event.amount;
        else {
          requireRuntime(
            entry.reconciled === undefined || entry.reconciled === event.amount,
            "conflicting-budget-reconciliation",
          );
          entry.reconciled = event.amount;
        }
        requireRuntime(
          Number.isFinite(entry.reserved) && entry.reserved <= Number.MAX_SAFE_INTEGER,
          "unsafe-accounting",
        );
        ledger.set(key, entry);
      }
    const totals = new Map<string, number>();
    for (const entry of ledger.values()) {
      const total = (totals.get(entry.unit) ?? 0) + (entry.reconciled ?? entry.reserved);
      requireRuntime(
        Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER,
        "unsafe-accounting",
      );
      totals.set(entry.unit, total);
    }
    const usage = deriveBudgetUsage(events);
    const attempts = new Map<string, Attempt[]>();
    for (const event of events)
      if (event.kind === "attempt") {
        const group = attempts.get(attemptKey(event)) ?? [];
        group.push(event);
        attempts.set(attemptKey(event), group);
      }
    const counts = new Map<number, number>();
    for (const group of attempts.values())
      if (!group.some((event) => event.event === "AttemptDeferred"))
        counts.set(group[0]!.workItem, (counts.get(group[0]!.workItem) ?? 0) + 1);
    const unknown: Array<{ workItem: number; attempt: number }> = [];
    for (const group of currentAttempts.values()) {
      const finished = group.filter((event) => workerTerminals.has(event.event));
      if (!group.some((event) => event.event === "AttemptStarted") || !finished.length) continue;
      const budget = suffix.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.unit === "model_tokens" &&
          event.phase === "execution" &&
          attemptKey(event) === attemptKey(group[0]!),
      );
      const reported = finished.filter((event) => event.reportedModelTokens !== undefined);
      requireRuntime(
        !budget.length ||
          reported.every((event) =>
            budget.every(
              (receipt) =>
                receipt.kind === "budget" && receipt.amount === event.reportedModelTokens,
            ),
          ),
        "conflicting-worker-usage",
      );
      if (!budget.length || !reported.length)
        unknown.push({ workItem: group[0]!.workItem, attempt: group[0]!.attempt });
    }
    return {
      status: "verified",
      adoptionVerified: true,
      executionAuthorized: false,
      controllingRun,
      planRecord: record,
      claim,
      graph,
      projection,
      sourceRunIds,
      accountingRunIds: [...sourceRunIds, input.runId],
      events,
      currentEvents,
      sourceEvidence,
      sourceIntegrations,
      verifiedSourceCapacity: [...sourceCapacity],
      sourcePublications,
      historicalAccounting: chain.accounting,
      usage,
      remaining: remainingBudget(plan.acceptedPolicy, usage),
      attemptCounts: [...counts].map(([workItem, count]) => ({
        workItem,
        count,
        remaining: Math.max(0, plan.acceptedPolicy.maxAttemptsPerItem - count),
      })),
      currentUnknownModelUsage: unknown.slice(0, 100),
      currentUnknownModelUsageCount: unknown.length,
    };
  } catch (error) {
    return {
      status: "blocked",
      adoptionVerified: false,
      executionAuthorized: false,
      blockers: [error instanceof RuntimeBindingError ? error.code : "runtime-binding-unavailable"],
    };
  }
}
