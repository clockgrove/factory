import type { FactoryReadSnapshot } from "../application/status.js";
import type { CompiledGraphStore } from "../control/graphs.js";
import type { LeaseManager, LeaseState } from "../control/lease.js";
import { deduplicateFactoryEvents, encodeEventComment } from "../control/receipts.js";
import type { RunEventStore } from "../control/runs.js";
import type {
  RepositoryLeaseManager,
  RepositoryLeaseState,
} from "../controller/repository-lease.js";
import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { verifyRecoveryAdmission } from "./admission.js";
import type { RecoveryReadStore } from "./assessment.js";
import { verifyRecoveryChain } from "./chain.js";
import { RecoveryClaimManager, loadRecoveryClaim, type RecoveryClaimRecord } from "./claims.js";
import { recoveryEvidenceDigest, resolveRecoveryEvidence } from "./evidence.js";
import { recoveryClaimRef, recoveryEventDigest } from "./identity.js";
import type { observeLocalRecoveryResource } from "./local-resources.js";
import { loadRecoveryPlan, type RecoveryPlanRecord } from "./plan.js";
import { inspectRecoveryAdoption } from "./transaction.js";
import { verifyRecoveryResources } from "./resources.js";
import type { LocalScopeReadPort } from "../runtime/local-scope.js";

type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
type Request = Extract<FactoryEvent, { event: "RecoveryRequested" }>;
interface CoordinatorPorts {
  /** Actual GitHub adapters must retain the shared mutation pacing/circuit breaker. */
  store: RecoveryReadStore & CompiledGraphStore & RunEventStore;
  /** Complete reader-authenticated Objective and child history, never user-supplied envelopes. */
  readSnapshot(): Promise<{ snapshot: FactoryReadSnapshot; historyComplete: boolean }>;
  objectiveLeases: Pick<LeaseManager, "assertCurrent">;
  repositoryLeases: Pick<RepositoryLeaseManager, "assertCurrent">;
  /** Test seam for the concrete read-only local observer, not an eligibility callback. */
  observeLocalResource?: typeof observeLocalRecoveryResource;
  scopePort?: LocalScopeReadPort;
}
interface AdoptionInput {
  objective: number;
  planDigest: string;
  objectiveLease: LeaseState;
  repositoryLease: RepositoryLeaseState;
}
export interface RecoveryCoordinatorResult {
  status: "adopted" | "pending" | "blocked";
  executionAuthorized: false;
  successorRunId: string | null;
  claimOid: string | null;
  blockers: string[];
}
interface Inspection {
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord | null;
  request: Request;
  predecessor: Start;
  events: FactoryEvent[];
  evidenceDigest: string;
  accountingDigest: string;
  resourceEvidenceDigest: string;
}
class RecoveryGateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireGate(condition: unknown, code: string): asserts condition {
  if (!condition) throw new RecoveryGateError(code);
}

/**
 * Fenced durable adoption, not Supervisor admission. It writes only the fixed
 * claim and three transaction receipts, never source attempts, budgets, PRs,
 * terminal outcomes, process signals, or workers. Runtime execution stays gated
 * until scheduling/publication/state consume the same verified adoption evidence.
 */
export class RecoveryCoordinator {
  constructor(private readonly ports: CoordinatorPorts) {}

  async #fence(input: AdoptionInput): Promise<void> {
    await this.ports.repositoryLeases.assertCurrent(input.repositoryLease);
    await this.ports.objectiveLeases.assertCurrent(input.objectiveLease);
  }

  async #inspect(input: AdoptionInput): Promise<Inspection> {
    await this.#fence(input);
    const { store } = this.ports;
    const { snapshot, historyComplete } = await this.ports.readSnapshot();
    requireGate(
      historyComplete &&
        snapshot.number === input.objective &&
        snapshot.closed === false &&
        Array.isArray(snapshot.factoryEvents) &&
        snapshot.workItems.length <= 100 &&
        snapshot.workItems.every((item) => Array.isArray(item.factoryEvents)),
      "snapshot-incomplete",
    );
    const raw = [
      ...snapshot.factoryEvents!,
      ...snapshot.workItems.flatMap((item) => item.factoryEvents!),
    ];
    requireGate(raw.length <= 10_000, "history-bound");
    const events = deduplicateFactoryEvents(raw.map(parseFactoryEvent));
    const record = await loadRecoveryPlan(store, input.objective, input.planDigest);
    requireGate(record, "plan-unavailable");
    const plan = record.plan;
    requireGate(
      snapshot.id === plan.objectiveNodeId &&
        snapshot.repositoryId === plan.repositoryId &&
        snapshot.defaultBranch === plan.baseBranch &&
        input.objectiveLease.objective === plan.objective &&
        input.objectiveLease.runId === plan.successorRunId &&
        input.objectiveLease.policyDigest === plan.policyDigest,
      "scope-binding-mismatch",
    );
    const requests = events.filter(
      (event): event is Request =>
        event.event === "RecoveryRequested" && event.requestId === plan.requestId,
    );
    const starts = events.filter(
      (event): event is Start =>
        event.event === "FactoryRunStarted" && event.runId === plan.predecessor.runId,
    );
    requireGate(requests.length === 1 && starts.length === 1, "authority-unavailable");
    const request = requests[0]!;
    const predecessor = starts[0]!;
    requireGate(
      request.requestedBy.toLowerCase() === predecessor.actor.toLowerCase() &&
        events.filter(
          (event) =>
            event.event === "RecoveryRequested" &&
            event.predecessorRunId === plan.predecessor.runId,
        ).length === 1,
      "competing-or-foreign-request",
    );
    const plans: Record<string, RecoveryPlanRecord> = { [record.digest]: record };
    let prior = plan.priorPlanDigest;
    while (prior !== null) {
      requireGate(!plans[prior] && Object.keys(plans).length < 100, "ancestry-bound-or-cycle");
      const loaded = await loadRecoveryPlan(store, input.objective, prior);
      requireGate(loaded, "prior-plan-unavailable");
      plans[prior] = loaded;
      prior = loaded.plan.priorPlanDigest;
    }
    const claimRefs = await store.listRefs(
      `refs/clockgrove-factory/recovery-claims/objective-${input.objective}/`,
    );
    requireGate(claimRefs.length <= 100, "claim-bound");
    const claims: RecoveryClaimRecord[] = [];
    for (const ref of claimRefs) {
      const source = plan.history.find(
        (entry) => recoveryClaimRef(input.objective, entry.runId) === ref.ref,
      );
      requireGate(source, "unplanned-claim");
      const claim = await loadRecoveryClaim(store, input.objective, source.runId);
      requireGate(claim && claim.oid === ref.oid, "claim-observation-changed");
      claims.push(claim);
    }
    const candidate =
      claims.find((claim) => claim.predecessorRunId === plan.predecessor.runId) ?? null;
    if (candidate) {
      const replay = inspectRecoveryAdoption({
        planRecord: record,
        claim: candidate,
        authenticatedRequest: request,
        predecessorStart: predecessor,
        events,
        historyComplete,
      });
      requireGate(replay.state !== "blocked", "adoption-replay-conflict");
    } else {
      requireGate(
        !events.some((event) => event.runId === plan.successorRunId),
        "unclaimed-successor-history",
      );
    }
    // Only an exact verified candidate transaction prefix can be projected out.
    // The chain checker still sees every other run, claim, request, and charge.
    const sourceEvents = candidate
      ? events.filter((event) => event.runId !== plan.successorRunId)
      : events;
    const chain = verifyRecoveryChain({
      repository: plan.repository,
      repositoryId: plan.repositoryId,
      objective: plan.objective,
      objectiveNodeId: plan.objectiveNodeId,
      historyComplete,
      events: sourceEvents,
      plansByDigest: plans,
      claims: claims.filter((claim) => claim !== candidate),
      candidatePlan: plan,
    });
    const admission = verifyRecoveryAdmission({
      planRecord: record,
      chain,
      required: {
        modelTokens: 0,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttempts: [],
      },
    });
    requireGate(admission.status === "verified", "accounting-or-chain-blocked");
    const evidence = await resolveRecoveryEvidence({
      planRecord: record,
      claim: candidate,
      events,
      store,
      snapshot,
    });
    requireGate(
      evidence.sourceBindings === "verified" &&
        evidence.currentBase === "unchanged" &&
        evidence.blockers.every((blocker) => blocker.code === "resource-cleanup-unverified"),
      "source-evidence-blocked",
    );
    const resources = await this.#resources(record, events);
    const observation: Inspection = {
      planRecord: record,
      claim: candidate,
      request,
      predecessor,
      events,
      accountingDigest: admission.accountingDigest,
      evidenceDigest: recoveryEvidenceDigest(evidence),
      resourceEvidenceDigest: resources,
    };
    if (candidate)
      requireGate(
        candidate.transaction.evidenceDigest === observation.evidenceDigest &&
          candidate.transaction.accountingDigest === observation.accountingDigest &&
          candidate.transaction.resourceEvidenceDigest === observation.resourceEvidenceDigest,
        "claimed-evidence-changed",
      );
    await this.#fence(input);
    return observation;
  }

  async #resources(record: RecoveryPlanRecord, events: FactoryEvent[]): Promise<string> {
    const result = await verifyRecoveryResources({
      planRecord: record,
      events,
      store: this.ports.store,
      ...(this.ports.observeLocalResource
        ? { observeLocalResource: this.ports.observeLocalResource }
        : {}),
      ...(this.ports.scopePort ? { scopePort: this.ports.scopePort } : {}),
    });
    requireGate(
      result.status === "verified" && result.evidenceDigest,
      result.blockers[0] ?? "resource-absence-unverified",
    );
    return result.evidenceDigest;
  }

  async adopt(input: AdoptionInput): Promise<RecoveryCoordinatorResult> {
    let inspection: Inspection | null = null;
    let uncertainWrite = false;
    const result = (
      status: RecoveryCoordinatorResult["status"],
      blockers: string[] = [],
    ): RecoveryCoordinatorResult => ({
      status,
      executionAuthorized: false,
      successorRunId: inspection?.planRecord.plan.successorRunId ?? null,
      claimOid: inspection?.claim?.oid ?? null,
      blockers,
    });
    try {
      inspection = await this.#inspect(input);
      if (!inspection.claim) {
        const { planRecord, request } = inspection;
        const maximum = Math.max(0, ...inspection.events.map((event) => event.sequence));
        requireGate(
          Number.isSafeInteger(maximum) && maximum <= Number.MAX_SAFE_INTEGER - 3,
          "sequence-exhausted",
        );
        const at = (await this.ports.store.serverTime()).toISOString();
        await this.#fence(input);
        const manager = new RecoveryClaimManager(this.ports.store, {
          assertCurrent: async () => this.#fence(input),
        });
        uncertainWrite = true;
        inspection.claim = await manager.claim({
          lease: input.objectiveLease,
          planRecord,
          authenticatedRequest: request,
          transaction: {
            at,
            startSequence: maximum + 1,
            evidenceDigest: inspection.evidenceDigest,
            accountingDigest: inspection.accountingDigest,
            resourceEvidenceDigest: inspection.resourceEvidenceDigest,
          },
        });
        uncertainWrite = false;
      }
      // At most three new comments. Every observation reloads authoritative
      // state; lost responses do not trigger blind retries or terminal writes.
      for (let step = 0; step <= 3; step++) {
        inspection = await this.#inspect(input);
        requireGate(inspection.claim, "claim-unavailable");
        const replay = inspectRecoveryAdoption({
          planRecord: inspection.planRecord,
          claim: inspection.claim,
          authenticatedRequest: inspection.request,
          predecessorStart: inspection.predecessor,
          events: inspection.events,
          historyComplete: true,
        });
        if (replay.state === "complete") return result("adopted");
        requireGate(
          replay.state !== "blocked" && replay.nextEvent && step < 3,
          "adoption-replay-conflict",
        );
        const expectedDigest = recoveryEventDigest(replay.nextEvent);
        await this.#fence(input);
        uncertainWrite = true;
        try {
          await this.ports.store.addIssueComment(
            inspection.planRecord.plan.objectiveNodeId,
            encodeEventComment(
              "Factory recorded an immutable recovery adoption step.",
              replay.nextEvent,
            ),
          );
        } catch {
          const reloaded = await this.#inspect(input);
          if (!reloaded.events.some((event) => recoveryEventDigest(event) === expectedDigest))
            return result("pending", ["comment-response-unresolved"]);
          inspection = reloaded;
        }
        uncertainWrite = false;
      }
      return result("pending", ["adoption-incomplete"]);
    } catch (error) {
      return result(uncertainWrite ? "pending" : "blocked", [
        error instanceof RecoveryGateError ? error.code : "recovery-observation-unavailable",
      ]);
    }
  }
}
