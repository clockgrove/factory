import { createHash } from "node:crypto";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { type RunPolicy, policyDigest } from "../protocol/policy.js";
import { assessRecoveryAccounting, type RecoveryAccountingAssessment } from "./accounting.js";
import { recoveryClaimRef, recoveryEventDigest, recoverySourceEventsDigest } from "./identity.js";
import {
  parseRecoveryPlan,
  recoveryHistoryDigest,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryAllowance,
  type RecoveryPlan,
  type RecoveryPlanRecord,
} from "./plan.js";

export { recoveryEventDigest, recoverySourceEventsDigest, recoveryClaimRef } from "./identity.js";
type Start = Extract<FactoryEvent, { event: "FactoryRunStarted" }>;
type Request = Extract<FactoryEvent, { event: "RecoveryRequested" }>;
type Consumed = Extract<FactoryEvent, { event: "RecoveryConsumed" }>;

/** Independently loaded immutable claim payload and observed ref/commit, not user-asserted authority. */
export interface RecoveryClaimObservation {
  ref: string;
  oid: string;
  repository: string;
  objective: number;
  requestId: string;
  planDigest: string;
  predecessorRunId: string;
  predecessorTerminalDigest: string;
  successorRunId: string;
}
export interface RecoveryChainVerification {
  status: "verified" | "blocked";
  executionAuthorized: false;
  rootPlanDigest: string | null;
  verifiedAccountingRunIds: string[];
  allowance: RecoveryPlan["allowance"] | null;
  accounting: RecoveryAccountingAssessment | null;
  blockers: Array<{ code: string; reason: string }>;
  blockerCount: number;
  blockersTruncated: boolean;
}

const terminalNames = new Set([
  "FactoryRunCompleted",
  "FactoryRunEscalated",
  "FactoryRunCancelled",
]);
const allowanceFor = (policy: RunPolicy): RecoveryAllowance => ({
  modelTokens: policy.economics?.maxModelTokens ?? null,
  sandboxMinutes: policy.maxSandboxMinutes,
  managedSessions: policy.maxManagedAgentSessions,
  implementationAttemptsPerItem: policy.maxAttemptsPerItem,
});
const sameAllowance = (left: RecoveryAllowance, right: RecoveryAllowance) =>
  left.modelTokens === right.modelTokens &&
  left.sandboxMinutes === right.sandboxMinutes &&
  left.managedSessions === right.managedSessions &&
  left.implementationAttemptsPerItem === right.implementationAttemptsPerItem;

/** Acknowledgement identity includes the full source fence even when diagnostics are bounded. */
export function recoveryUnknownUsageDigest(
  sourceEventsDigest: string,
  accounting: RecoveryAccountingAssessment,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceEventsDigest,
        unknownModelUsageCount: accounting.unknownModelUsageCount,
        unknownModelUsage: accounting.unknownModelUsage,
        diagnosticsTruncated: accounting.diagnosticsTruncated,
      }),
    )
    .digest("hex");
}

/**
 * Verifies proposal/ancestry bindings only. Callers supply complete reader-authenticated events,
 * plans returned by the immutable-plan loader, and independently observed claims. Neither a
 * verified proposal nor an unknown-usage acknowledgement authorizes execution or proves cleanup.
 */
export function verifyRecoveryChain(input: {
  repository: string;
  repositoryId: string;
  objective: number;
  objectiveNodeId: string;
  historyComplete: boolean;
  events: readonly FactoryEvent[];
  plansByDigest: Readonly<Record<string, RecoveryPlanRecord>>;
  claims: readonly RecoveryClaimObservation[];
  candidatePlan: RecoveryPlan;
}): RecoveryChainVerification {
  const result: RecoveryChainVerification = {
    status: "verified",
    executionAuthorized: false,
    rootPlanDigest: null,
    verifiedAccountingRunIds: [],
    allowance: null,
    accounting: null,
    blockers: [],
    blockerCount: 0,
    blockersTruncated: false,
  };
  const block = (code: string, reason: string) => {
    result.status = "blocked";
    result.blockerCount++;
    if (result.blockers.length < 100) result.blockers.push({ code, reason });
    else result.blockersTruncated = true;
  };
  const require = (condition: unknown, code: string, reason: string) => {
    if (!condition) {
      block(code, reason);
      throw new Error("recovery binding unavailable");
    }
  };
  try {
    require(input.historyComplete === true &&
      input.events.length <= 50_000 &&
      input.claims.length <= 100 &&
      Object.keys(input.plansByDigest).length <=
        100, "history-incomplete", "Complete bounded authenticated history, immutable plans, and claim observations are required.");
    const candidate = parseRecoveryPlan(input.candidatePlan);
    const candidateDigest = recoveryPlanDigest(candidate);
    const events = deduplicateFactoryEvents(input.events.map(parseFactoryEvent));
    require(events.every(
      (event) => event.objective === input.objective && Number.isSafeInteger(event.sequence),
    ), "event-scope-mismatch", "History contains a foreign Objective or unsafe event sequence.");
    const starts = new Map<string, Start>();
    for (const event of events) {
      if (event.kind !== "run" || event.event !== "FactoryRunStarted") continue;
      require(!starts.has(event.runId) &&
        event.repository.toLowerCase() === input.repository.toLowerCase() &&
        policyDigest(event.policy) ===
          event.policyDigest, "start-binding-invalid", "Historical start identity, repository, or source policy is conflicting.");
      starts.set(event.runId, event);
    }
    require(starts.size > 0 &&
      starts.size <= 100 &&
      !starts.has(
        candidate.successorRunId,
      ), "candidate-already-started", "Candidate requires bounded historical starts and a successor that has not already started.");
    require(events.every(
      (event) =>
        !["attempt", "capacity", "validation", "publication", "budget", "graph"].includes(
          event.kind,
        ) || starts.has(event.runId),
    ), "orphan-source-history", "Source execution or budget history has no authenticated run start.");
    const plans = new Map<string, RecoveryPlan>();
    for (const [digest, record] of Object.entries(input.plansByDigest)) {
      const plan = parseRecoveryPlan(record.plan);
      require(digest === recoveryPlanDigest(plan) &&
        record.digest === digest &&
        record.ref === recoveryPlanRef(input.objective, digest) &&
        /^[0-9a-f]{40}$/.test(record.commitOid) &&
        /^[0-9a-f]{40}$/.test(
          record.blobOid,
        ), "plan-observation-invalid", "A prior plan does not match its immutable loader identity.");
      plans.set(digest, plan);
    }
    plans.set(candidateDigest, candidate);
    const chain: Array<{ digest: string; plan: RecoveryPlan }> = [];
    const seen = new Set<string>();
    let cursor: string | null = candidateDigest;
    while (cursor !== null) {
      require(!seen.has(cursor) &&
        chain.length < 100 &&
        plans.has(
          cursor,
        ), "chain-cycle-or-missing-plan", "Prior-plan links are cyclic, unbounded, or missing; chronological order does not establish a link.");
      seen.add(cursor);
      const plan: RecoveryPlan = plans.get(cursor)!;
      chain.unshift({ digest: cursor, plan });
      cursor = plan.priorPlanDigest;
    }
    const requests = events.filter(
      (event): event is Request => event.event === "RecoveryRequested",
    );
    const consumed = events.filter(
      (event): event is Consumed => event.event === "RecoveryConsumed",
    );
    const consumedByPredecessor = new Map<string, string>();
    for (const event of consumed) {
      const binding = JSON.stringify([
        event.runId,
        event.recoveryRequestId,
        event.planDigest,
        event.claimRef,
        event.claimOid,
        event.predecessorTerminalDigest,
      ]);
      const previous = consumedByPredecessor.get(event.predecessorRunId);
      require(previous === undefined ||
        previous ===
          binding, "forked-successor", "One predecessor has conflicting consumed successors or claim identities.");
      consumedByPredecessor.set(event.predecessorRunId, binding);
    }
    const requestFor = (
      plan: RecoveryPlan,
      digest: string,
      required: boolean,
    ): Request | undefined => {
      const matches = requests.filter((request) => request.requestId === plan.requestId);
      require((!required || matches.length === 1) &&
        matches.length <=
          1, "request-unavailable", "The exact authenticated recovery request is missing or ambiguous.");
      const request = matches[0];
      if (request)
        require(request.planDigest === digest &&
          request.repository.toLowerCase() === plan.repository.toLowerCase() &&
          request.runId === plan.predecessor.runId &&
          request.predecessorRunId === plan.predecessor.runId &&
          request.predecessorTerminalDigest === plan.predecessor.terminalDigest &&
          request.successorRunId === plan.successorRunId &&
          request.policyDigest === plan.policyDigest &&
          request.baseSha === plan.expectedBaseSha &&
          request.sequence >
            plan.sourceEventMaxSequence, "request-plan-mismatch", "Authenticated request differs from the exact source fence, predecessor, policy, base, or successor plan.");
      return request;
    };
    for (let index = 0; index < chain.length; index++) {
      const { digest, plan } = chain[index]!;
      const current = index === chain.length - 1;
      require(plan.repository.toLowerCase() === input.repository.toLowerCase() &&
        plan.repositoryId === input.repositoryId &&
        plan.objective === input.objective &&
        plan.objectiveNodeId ===
          input.objectiveNodeId, "plan-scope-mismatch", "Plan does not bind the exact observed repository and Objective identity.");
      const expectedStarts = [...starts.values()]
        .filter((start) => current || start.sequence <= plan.sourceEventMaxSequence)
        .sort((left, right) => left.sequence - right.sequence);
      require(expectedStarts.length === plan.history.length &&
        expectedStarts.every(
          (start, position) => start.runId === plan.history[position]?.runId,
        ), "omitted-history", "Plan must include every started historical run, including graph-only failures; history cannot be selected to replenish allowance.");
      for (const entry of plan.history) {
        const start = starts.get(entry.runId)!;
        const terminal = events.filter(
          (event) => event.runId === entry.runId && terminalNames.has(event.event),
        );
        require(terminal.length === 1 &&
          terminal[0]!.sequence > start.sequence &&
          terminal[0]!.sequence <= plan.sourceEventMaxSequence &&
          recoveryEventDigest(start) === entry.startDigest &&
          start.policyDigest === entry.policyDigest &&
          recoveryEventDigest(terminal[0]!) === entry.terminalDigest &&
          terminal[0]!.event === entry.terminalEvent &&
          terminal[0]!.sequence ===
            entry.terminalSequence, "terminal-history-mismatch", "Historical start, terminal envelope, sequence, or policy does not match the immutable history entry.");
      }
      require(recoveryHistoryDigest(plan.history) === plan.historyDigest &&
        recoverySourceEventsDigest({
          objective: input.objective,
          runIds: plan.history.map((entry) => entry.runId),
          events,
          maxSequence: plan.sourceEventMaxSequence,
        }) ===
          plan.sourceEventsDigest, "source-fence-mismatch", "Source receipt history changed at the acknowledged snapshot fence.");
      const selected = new Set(plan.history.map((entry) => entry.runId));
      const observedMax = events.reduce(
        (maximum, event) =>
          event.kind !== "recovery" &&
          selected.has(event.runId) &&
          event.sequence <= plan.sourceEventMaxSequence
            ? Math.max(maximum, event.sequence)
            : maximum,
        -1,
      );
      require(observedMax ===
        plan.sourceEventMaxSequence, "source-cutoff-unobserved", "Source cutoff must name the maximum observed source receipt, not a fabricated future sequence.");
      if (current)
        require(!events.some(
          (event) =>
            event.kind !== "recovery" &&
            selected.has(event.runId) &&
            event.sequence > plan.sourceEventMaxSequence,
        ), "candidate-source-advanced", "New source receipts require a new candidate plan and acknowledgement.");
      const predecessor = starts.get(plan.predecessor.runId)!;
      const previous = chain[index - 1];
      require(sameAllowance(
        plan.allowance.before,
        previous ? previous.plan.allowance.after : allowanceFor(predecessor.policy),
      ), "allowance-before-mismatch", "Allowance must carry the prior accepted total, or the bootstrap predecessor's policy; it cannot reset from a fresh run.");
      if (previous)
        require(plan.predecessor.runId === previous.plan.successorRunId &&
          plan.baseBranch === previous.plan.baseBranch &&
          plan.graph.digest === previous.plan.graph.digest &&
          plan.graph.projection.bindingDigest ===
            previous.plan.graph.projection
              .bindingDigest, "predecessor-chain-mismatch", "Successor recovery must continue the explicitly linked predecessor and unchanged Objective graph.");
      const request = requestFor(plan, digest, !current);
      if (!current) {
        const start = starts.get(plan.successorRunId);
        require(start &&
          request &&
          start.recoveryRequestId === plan.requestId &&
          start.recoveryPlanDigest === digest &&
          start.predecessorRunId === plan.predecessor.runId &&
          start.policyDigest === plan.policyDigest &&
          start.baseSha === plan.expectedBaseSha &&
          start.baseBranch === plan.baseBranch &&
          start.actor.toLowerCase() === request.requestedBy.toLowerCase() &&
          start.sequence >
            request.sequence, "successor-start-unbound", "Admitted successor start lacks its exact authenticated request, policy, base, and predecessor binding.");
        const records = consumed.filter((event) => event.runId === plan.successorRunId);
        require(records.length > 0 &&
          records.every(
            (event) =>
              event.planDigest === digest &&
              event.recoveryRequestId === plan.requestId &&
              event.predecessorRunId === plan.predecessor.runId &&
              event.predecessorTerminalDigest === plan.predecessor.terminalDigest &&
              event.sequence > request!.sequence,
          ), "consumption-unbound", "An admitted start must match its consumed recovery receipt; a proposal alone grants nothing.");
        const claimRef = recoveryClaimRef(input.objective, plan.predecessor.runId);
        const observed = input.claims.filter((claim) => claim.ref === claimRef);
        require(observed.length === 1 &&
          observed[0]!.repository.toLowerCase() === input.repository.toLowerCase() &&
          observed[0]!.objective === input.objective &&
          observed[0]!.requestId === plan.requestId &&
          observed[0]!.planDigest === digest &&
          observed[0]!.predecessorRunId === plan.predecessor.runId &&
          observed[0]!.predecessorTerminalDigest === plan.predecessor.terminalDigest &&
          observed[0]!.successorRunId === plan.successorRunId &&
          records.every(
            (event) => event.claimRef === claimRef && event.claimOid === observed[0]!.oid,
          ), "claim-observation-mismatch", "The immutable claim ref/payload/commit is unobserved or differs from the request and consumed start.");
      }
      const historical = events.filter(
        (event) =>
          selected.has(event.runId) &&
          event.kind !== "recovery" &&
          (!current ? event.sequence <= plan.sourceEventMaxSequence : true),
      );
      const accounting = assessRecoveryAccounting({
        objective: input.objective,
        repository: input.repository,
        events: historical,
        runIds: plan.history.map((entry) => entry.runId),
        policy: plan.acceptedPolicy,
      });
      require(accounting.usage !==
        null, "accounting-unavailable", "Historical accounting is ambiguous or unsafe; no allowance can be established.");
      if (plan.unknownUsageAcknowledgementDigest !== null)
        require(plan.unknownUsageAcknowledgementDigest ===
          recoveryUnknownUsageDigest(
            plan.sourceEventsDigest,
            accounting,
          ), "unknown-usage-acknowledgement-mismatch", "Unknown-usage acknowledgement differs from the full source fence and bounded accounting diagnostics.");
      if (current) {
        result.accounting = accounting;
        result.allowance = plan.allowance;
      }
    }
    const priorSuccessors = new Set(chain.slice(0, -1).map(({ plan }) => plan.successorRunId));
    const bootstrap = chain[0]!.plan;
    for (const start of starts.values())
      require(priorSuccessors.has(start.runId) ||
        (start.sequence <= bootstrap.sourceEventMaxSequence &&
          !start.recoveryRequestId &&
          !start.recoveryPlanDigest &&
          !start.predecessorRunId), "unlinked-historical-successor", "Every admitted successor requires an explicit verified prior-plan edge; chronological starts are not authority.");
    require(consumed.every((event) =>
      priorSuccessors.has(event.runId),
    ), "unlinked-consumption", "Consumed recovery history names an unverified successor or alternative chain.");
    require(!input.claims.some(
      (claim) => claim.ref === recoveryClaimRef(input.objective, candidate.predecessor.runId),
    ), "candidate-predecessor-claimed", "The candidate predecessor already has a claim; reconcile that outcome without overwriting or deleting it.");
    require(input.claims.every((claim) =>
      chain
        .slice(0, -1)
        .some(
          ({ plan }) => claim.ref === recoveryClaimRef(input.objective, plan.predecessor.runId),
        ),
    ), "unlinked-claim", "A historical predecessor has an unbound pending claim; its outcome must be reconciled rather than ignored.");
    result.rootPlanDigest = chain[0]!.digest;
    result.verifiedAccountingRunIds = candidate.history.map((entry) => entry.runId);
  } catch {
    if (result.status !== "blocked")
      block(
        "invalid-recovery-input",
        "Recovery history, plan, policy, or claim input is malformed or conflicting.",
      );
  }
  return result;
}
