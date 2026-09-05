import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { policyDigest } from "../protocol/policy.js";
import {
  assertRecoveryClaimBinding,
  type AuthenticatedRecoveryRequest,
  type RecoveryClaimRecord,
} from "./claims.js";
import { recoveryEventDigest, recoverySourceEventsDigest } from "./identity.js";
import { parseRecoveryPlan, type RecoveryPlanRecord } from "./plan.js";

type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
type Consumed = Extract<FactoryEvent, { event: "RecoveryConsumed" }>;
type Completed = Extract<FactoryEvent, { event: "RecoveryAdoptionCompleted" }>;
interface TransactionBinding {
  /** Must come from the immutable loaders and a complete authenticated reader. */
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  authenticatedRequest: AuthenticatedRecoveryRequest;
  predecessorStart: Start;
}

function requireBinding(condition: unknown): asserts condition {
  if (!condition) throw new Error("Recovery adoption transaction binding is unavailable");
}

/**
 * Reconstruct the exact envelopes fixed by an immutable claim, including their
 * timestamps and sequences. No clock, sequence allocation, GitHub write, cleanup
 * inference, or worker admission occurs here. The claim's evidence digests name
 * observations; this helper does not prove those observations are still valid.
 */
export function recoveryAdoptionEvents(
  input: TransactionBinding,
): readonly [Start, Consumed, Completed] {
  const plan = parseRecoveryPlan(input.planRecord.plan);
  assertRecoveryClaimBinding(input);
  const predecessor = parseFactoryEvent(input.predecessorStart);
  requireBinding(predecessor.event === "FactoryRunStarted");
  requireBinding(
    predecessor.objective === plan.objective &&
      predecessor.runId === plan.predecessor.runId &&
      recoveryEventDigest(predecessor) === plan.predecessor.startDigest &&
      predecessor.repository.toLowerCase() === plan.repository.toLowerCase() &&
      predecessor.baseBranch === plan.baseBranch &&
      predecessor.actor.toLowerCase() === input.authenticatedRequest.requestedBy.toLowerCase() &&
      policyDigest(predecessor.policy) === predecessor.policyDigest,
  );
  const { claim } = input;
  const common = {
    protocol: predecessor.protocol,
    objective: plan.objective,
    runId: plan.successorRunId,
    at: claim.transaction.at,
  };
  const start = parseFactoryEvent({
    ...common,
    kind: "run",
    event: "FactoryRunStarted",
    sequence: claim.transaction.startSequence,
    actor: predecessor.actor,
    repository: plan.repository,
    objectiveAuthor: predecessor.objectiveAuthor,
    fork: predecessor.fork,
    baseBranch: plan.baseBranch,
    baseSha: plan.expectedBaseSha,
    policy: plan.acceptedPolicy,
    policyDigest: plan.policyDigest,
    recoveryRequestId: plan.requestId,
    recoveryPlanDigest: input.planRecord.digest,
    predecessorRunId: plan.predecessor.runId,
  });
  const adoptionBinding = {
    ...common,
    kind: "recovery",
    recoveryRequestId: plan.requestId,
    planDigest: input.planRecord.digest,
    predecessorRunId: plan.predecessor.runId,
    predecessorTerminalDigest: plan.predecessor.terminalDigest,
    claimRef: claim.ref,
    claimOid: claim.oid,
  };
  const consumed = parseFactoryEvent({
    ...adoptionBinding,
    event: "RecoveryConsumed",
    sequence: claim.transaction.startSequence + 1,
  });
  const completed = parseFactoryEvent({
    ...adoptionBinding,
    event: "RecoveryAdoptionCompleted",
    sequence: claim.transaction.startSequence + 2,
    evidenceDigest: claim.transaction.evidenceDigest,
    sourceEventsDigest: plan.sourceEventsDigest,
    accountingDigest: claim.transaction.accountingDigest,
    resourceEvidenceDigest: claim.transaction.resourceEvidenceDigest,
    baseSha: plan.expectedBaseSha,
  });
  requireBinding(
    start.event === "FactoryRunStarted" &&
      consumed.event === "RecoveryConsumed" &&
      completed.event === "RecoveryAdoptionCompleted",
  );
  return [start, consumed, completed];
}

export interface RecoveryAdoptionInspection {
  state: "pending" | "started" | "consumed" | "complete" | "blocked";
  executionAuthorized: false;
  /** Descriptive replay candidate only; never permission to append or execute. */
  nextEvent: FactoryEvent | null;
  blockers: string[];
}

/**
 * Inspect only a pending adoption transaction, not an executing successor.
 * Validate its exact authenticated prefix before considering any replay. In
 * particular, never erase candidate history to make proposal verification pass.
 *
 * A caller that eventually writes must independently verify ancestry, current
 * source/base/heads, cumulative accounting, resource cleanup, cancellation, and
 * both repository and Objective leases immediately before each effect. This
 * pure inspection cannot grant that authority, even in the complete state.
 */
export function inspectRecoveryAdoption(
  input: TransactionBinding & { events: readonly FactoryEvent[]; historyComplete: boolean },
): RecoveryAdoptionInspection {
  const blocked = (code: string): RecoveryAdoptionInspection => ({
    state: "blocked",
    executionAuthorized: false,
    nextEvent: null,
    blockers: [code],
  });
  try {
    if (!input.historyComplete || input.events.length > 50_000)
      return blocked("history-incomplete");
    const expected = recoveryAdoptionEvents(input);
    const plan = input.planRecord.plan;
    // Deduplicate only byte-equivalent parsed envelopes. Semantic deduplication
    // intentionally ignores timestamps and sequences elsewhere; using it here
    // would conceal conflicting transaction retries after a lost response.
    const unique = new Map<string, FactoryEvent>();
    for (const raw of input.events) {
      const event = parseFactoryEvent(raw);
      if (event.objective !== plan.objective || !Number.isSafeInteger(event.sequence))
        return blocked("event-scope-mismatch");
      unique.set(recoveryEventDigest(event), event);
    }
    const events = [...unique.values()];
    const sourceRuns = new Set(plan.history.map((entry) => entry.runId));
    if (events.some((event) => !sourceRuns.has(event.runId) && event.runId !== plan.successorRunId))
      return blocked("unplanned-run-history");
    const requests = events.filter(
      (event) =>
        event.event === "RecoveryRequested" && event.predecessorRunId === plan.predecessor.runId,
    );
    if (requests.length !== 1 || recoveryEventDigest(requests[0]!) !== input.claim.requestDigest)
      return blocked("request-missing-or-conflicting");
    if (
      !events.some((event) => recoveryEventDigest(event) === plan.predecessor.startDigest) ||
      !events.some(
        (event) =>
          event.runId === plan.predecessor.runId &&
          event.event === plan.predecessor.terminalEvent &&
          event.sequence === plan.predecessor.terminalSequence &&
          recoveryEventDigest(event) === plan.predecessor.terminalDigest,
      ) ||
      recoverySourceEventsDigest({
        objective: plan.objective,
        runIds: [...sourceRuns],
        events,
        // Include late-arriving source receipts, not just the old plan cutoff.
        maxSequence: Number.MAX_SAFE_INTEGER,
      }) !== plan.sourceEventsDigest
    )
      return blocked("source-fence-changed");
    const expectedDigests = expected.map(recoveryEventDigest);
    const observed = events.filter((event) => event.runId === plan.successorRunId);
    if (observed.some((event) => !expectedDigests.includes(recoveryEventDigest(event))))
      return blocked("unexpected-successor-event");
    for (const event of events) {
      if (
        event.runId !== plan.successorRunId &&
        event.sequence >= expected[0].sequence &&
        event.sequence <= expected[2].sequence
      )
        return blocked("transaction-sequence-collision");
    }
    const seen = new Set(observed.map(recoveryEventDigest));
    let prefix = 0;
    while (prefix < expected.length && seen.has(expectedDigests[prefix]!)) prefix++;
    if (observed.length !== prefix) return blocked("transaction-prefix-incomplete");
    const states = ["pending", "started", "consumed", "complete"] as const;
    return {
      state: states[prefix]!,
      executionAuthorized: false,
      nextEvent: expected[prefix] ?? null,
      blockers: [],
    };
  } catch {
    // Do not leak private event payloads or opaque provider errors in diagnostics.
    return blocked("transaction-binding-invalid");
  }
}
