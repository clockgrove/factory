import { attemptRef } from "../control/attempts.js";
import {
  loadMergeCandidateCheckpoint,
  mergeCandidateIdentityDigest,
  type MergeCandidateCheckpointRecord,
} from "../control/merge-candidates.js";
import { decodeEventTrailer } from "../control/receipts.js";
import {
  loadReviewCheckpoint,
  type ReviewCheckpointRecord,
  type ReviewIdentity,
} from "../control/reviews.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { verifyMergeCandidateSquash } from "../publication/merge-candidate.js";
import {
  bindValidationToPublishedHead,
  type ExactHeadValidationEvidence,
} from "../validation/plan.js";
import type { RecoveryReadStore } from "./assessment.js";
import { loadRecoveryClaim, type RecoveryClaimRecord } from "./claims.js";
import { recoveryEventDigest, recoverySourceEventsDigest } from "./identity.js";
import {
  loadRecoveryPlan,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlanRecord,
  type RecoveryPlan,
  type RecoveryPlanItem,
} from "./plan.js";
import { recoveryAdoptionEvents } from "./transaction.js";
import { observeRecoveryNativeTransition } from "./native-transition.js";
import {
  verifyRecoverySourcePublication,
  recoverySourcePublicationBinding,
  type RecoverySourcePublishedEvent,
} from "./source-publications.js";

export type RecoverySourceIntegratedEvent = Extract<
  FactoryEvent,
  { event: "RecoverySourceIntegrated" }
>;
export interface RecoverySourceIntegrationProof {
  status: "verified";
  executionAuthorized: false;
  outcome: RecoverySourceIntegratedEvent;
  sourceExactHeadValidation: ExactHeadValidationEvidence;
  targetBaseSha: string;
  outputTreeSha: string;
  candidate: MergeCandidateCheckpointRecord | null;
  candidateReview: ReviewCheckpointRecord | null;
}
export type RecoverySourceIntegrationResult =
  | RecoverySourceIntegrationProof
  | {
      status: "blocked";
      executionAuthorized: false;
      blockers: string[];
    };
function requireOutcome(condition: unknown): asserts condition {
  if (!condition) throw new Error("source integration binding unavailable");
}

/** Verify an explicitly acknowledged prior delivery, never infer an edge from chronology. */
export async function verifyPriorRecoveryDelivery(input: {
  plan: RecoveryPlan;
  item: RecoveryPlanItem;
  events: readonly FactoryEvent[];
  store: RecoveryReadStore;
}): Promise<RecoverySourceIntegrationProof> {
  const { plan, item, events, store } = input;
  const reference = item.source?.priorDelivery;
  requireOutcome(reference && item.action === "integrated" && plan.history.length <= 100);
  let cursor = plan.priorPlanDigest;
  const visited = new Set<string>();
  let record: RecoveryPlanRecord | null = null;
  while (cursor) {
    requireOutcome(!visited.has(cursor) && visited.size < 100);
    visited.add(cursor);
    const next = await loadRecoveryPlan(store, plan.objective, cursor);
    requireOutcome(
      next &&
        next.plan.repository === plan.repository &&
        next.plan.objectiveNodeId === plan.objectiveNodeId,
    );
    if (cursor === reference.planDigest) {
      record = next;
      break;
    }
    cursor = next.plan.priorPlanDigest;
  }
  requireOutcome(
    record &&
      record.plan.successorRunId === reference.runId &&
      record.plan.history.length < plan.history.length &&
      plan.history.some((entry) => entry.runId === reference.runId),
  );
  const priorItem = record.plan.items.find((value) => value.workItem === item.workItem);
  requireOutcome(
    priorItem?.source &&
      priorItem.compilerId === item.compilerId &&
      priorItem.issueNodeId === item.issueNodeId,
  );
  const core = (source: NonNullable<RecoveryPlanItem["source"]>) => {
    const { priorDelivery: _lineage, publication: _publication, ...original } = source;
    return JSON.stringify(original);
  };
  requireOutcome(core(priorItem.source) === core(item.source!));
  const matches = events.filter(
    (event) => recoveryEventDigest(event) === reference.integrationReceiptDigest,
  );
  requireOutcome(matches.length === 1 && matches[0]!.event === "RecoverySourceIntegrated");
  const outcome = matches[0]!;
  requireOutcome(
    outcome.runId === reference.runId &&
      outcome.planDigest === record.digest &&
      outcome.workItem === item.workItem &&
      outcome.sequence <= plan.sourceEventMaxSequence,
  );
  let publication = priorItem.source.publication;
  if (!publication) {
    const restored = events.filter(
      (event) => recoveryEventDigest(event) === outcome.sourcePublicationReceiptDigest,
    );
    requireOutcome(
      restored.length === 1 &&
        restored[0]!.event === "RecoverySourcePublished" &&
        restored[0]!.runId === reference.runId,
    );
    publication = recoverySourcePublicationBinding(restored[0]!, plan.repository);
  }
  requireOutcome(JSON.stringify(publication) === JSON.stringify(item.source!.publication));
  const claim = await loadRecoveryClaim(store, plan.objective, record.plan.predecessor.runId);
  requireOutcome(claim);
  const proof = await verifyRecoverySourceIntegration({
    planRecord: record,
    claim,
    events,
    store,
    outcome,
  });
  requireOutcome(
    proof.status === "verified" && reference.deliveryHeadSha === proof.outcome.deliveryHeadSha,
  );
  const pull = await store.readPullRequest(publication.pullRequest);
  requireOutcome(
    pull.merged &&
      pull.mergeCommitSha === outcome.mergeCommitSha &&
      pull.headSha === (proof.outcome.deliveryHeadSha ?? publication.headSha),
  );
  const pending = [plan.expectedBaseSha];
  const seen = new Set<string>();
  let included = false;
  while (pending.length) {
    const oid = pending.pop()!;
    if (oid === outcome.mergeCommitSha) {
      included = true;
      break;
    }
    if (seen.has(oid)) continue;
    requireOutcome(seen.size < 256);
    seen.add(oid);
    const commit = await store.readCommit(oid);
    requireOutcome(commit.oid === oid && commit.parentOids.length <= 16);
    pending.push(...commit.parentOids);
  }
  requireOutcome(included);
  return proof;
}

/** Identity construction only. Verify actual merge evidence before appending this receipt. */
export function createRecoverySourceIntegratedEvent(input: {
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  workItem: number;
  mergeCommitSha: string;
  mergeCandidateIdentityDigest?: string;
  deliveryHeadSha?: string;
  sourcePublication?: RecoverySourcePublishedEvent;
  sequence: number;
  at: string;
}): RecoverySourceIntegratedEvent {
  const { planRecord: record, claim } = input;
  const plan = record.plan;
  const item = plan.items.find((value) => value.workItem === input.workItem);
  const source = item?.source;
  const publication =
    source?.publication ??
    (input.sourcePublication
      ? recoverySourcePublicationBinding(input.sourcePublication, plan.repository)
      : null);
  requireOutcome(
    record.digest === recoveryPlanDigest(plan) &&
      record.ref === recoveryPlanRef(plan.objective, record.digest) &&
      claim.planDigest === record.digest &&
      claim.successorRunId === plan.successorRunId &&
      claim.requestId === plan.requestId &&
      source &&
      publication &&
      source.validation &&
      source.review &&
      ["integrated", "reuse-publication", "reuse-artifact", "revalidate"].includes(item!.action),
  );
  const value = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "recovery",
    event: "RecoverySourceIntegrated",
    objective: plan.objective,
    runId: plan.successorRunId,
    sequence: input.sequence,
    at: input.at,
    recoveryRequestId: plan.requestId,
    planDigest: record.digest,
    claimRef: claim.ref,
    claimOid: claim.oid,
    workItem: item!.workItem,
    sourceRunId: source.runId,
    sourceAttempt: source.attempt,
    sourceReservationRef: source.reservationRef,
    sourceReservationCommitOid: source.reservationCommitOid,
    sourceReservationReceiptDigest: source.reservationReceiptDigest,
    sourcePublicationReceiptDigest: publication.receiptDigest,
    sourceHeadSha: publication.headSha,
    mergeCommitSha: input.mergeCommitSha,
    ...(input.mergeCandidateIdentityDigest
      ? { mergeCandidateIdentityDigest: input.mergeCandidateIdentityDigest }
      : {}),
    ...(input.deliveryHeadSha ? { deliveryHeadSha: input.deliveryHeadSha } : {}),
  });
  requireOutcome(value.event === "RecoverySourceIntegrated");
  return value;
}

/**
 * Read-only verification of a proposed or already-recorded source delivery result.
 * Caller-supplied events must be complete reader-authenticated history. This does
 * not replace runtime-chain, current lease, cancellation, resource, or admission
 * checks, and never modifies the predecessor or asserts that a worker ran again.
 */
interface SourceProofInput {
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  events: readonly FactoryEvent[];
  store: RecoveryReadStore;
}
export interface RecoveryMergedSourceProof {
  workItem: number;
  mergeCommitSha: string;
  sourcePublication?: RecoverySourcePublishedEvent;
  mergeCandidateIdentityDigest?: string;
  deliveryHeadSha?: string;
}

export async function verifyRecoverySourceIntegration(
  input: SourceProofInput & {
    outcome: RecoverySourceIntegratedEvent;
  },
): Promise<RecoverySourceIntegrationResult> {
  const result = await verifySourceProof(input);
  if ("status" in result) return result;
  throw new Error("source outcome verifier returned an observation");
}

/** Actual merge observation only; does not allocate, synthesize, or append an outcome receipt. */
export async function verifyRecoveryMergedSource(
  input: SourceProofInput & { workItem: number },
): Promise<RecoveryMergedSourceProof> {
  const result = await verifySourceProof(input);
  if ("status" in result) throw new Error("merged source proof unavailable");
  return result;
}

async function verifySourceProof(
  input: SourceProofInput & ({ outcome: RecoverySourceIntegratedEvent } | { workItem: number }),
): Promise<RecoverySourceIntegrationResult | RecoveryMergedSourceProof> {
  try {
    requireOutcome(input.events.length <= 10_000);
    const events = [
      ...new Map(
        input.events.map((raw) => {
          const value = parseFactoryEvent(raw);
          return [recoveryEventDigest(value), value] as const;
        }),
      ).values(),
    ];
    requireOutcome(new Set(events.map((event) => event.sequence)).size === events.length);
    let reads = 0;
    const cache = new Map<string, Promise<unknown>>();
    // Never use the frozen capability port as a target whose methods are replaced.
    const store = new Proxy({} as RecoveryReadStore, {
      get(_target, property) {
        const operation = Reflect.get(input.store, property, input.store);
        if (typeof operation !== "function") return operation;
        return (...args: unknown[]) => {
          const key = JSON.stringify([property, args]);
          const previous = cache.get(key);
          if (previous) return previous;
          requireOutcome(++reads <= 1024);
          const pending = Promise.resolve().then(() => Reflect.apply(operation, input.store, args));
          cache.set(key, pending);
          return pending;
        };
      },
    });
    const record = await loadRecoveryPlan(
      store,
      input.planRecord.plan.objective,
      input.planRecord.digest,
    );
    requireOutcome(
      record &&
        record.commitOid === input.planRecord.commitOid &&
        record.blobOid === input.planRecord.blobOid &&
        record.ref === input.planRecord.ref,
    );
    const plan = record.plan;
    const claim = await loadRecoveryClaim(store, plan.objective, plan.predecessor.runId);
    requireOutcome(
      claim &&
        claim.oid === input.claim.oid &&
        claim.blobOid === input.claim.blobOid &&
        claim.planDigest === record.digest,
    );
    requireOutcome(events.every((event) => event.objective === plan.objective));
    const requests = events.filter(
      (event) => event.event === "RecoveryRequested" && event.requestId === plan.requestId,
    );
    const starts = events.filter(
      (event) => event.event === "FactoryRunStarted" && event.runId === plan.predecessor.runId,
    );
    requireOutcome(
      requests.length === 1 &&
        requests[0]!.event === "RecoveryRequested" &&
        starts.length === 1 &&
        starts[0]!.event === "FactoryRunStarted",
    );
    const envelopes = recoveryAdoptionEvents({
      planRecord: record,
      claim,
      authenticatedRequest: requests[0]!,
      predecessorStart: starts[0]!,
    });
    requireOutcome(
      envelopes.every((expected) =>
        events.some((event) => recoveryEventDigest(event) === recoveryEventDigest(expected)),
      ),
    );
    requireOutcome(
      recoverySourceEventsDigest({
        objective: plan.objective,
        runIds: plan.history.map((value) => value.runId),
        events,
        maxSequence: Number.MAX_SAFE_INTEGER,
      }) === plan.sourceEventsDigest,
    );
    const exact = (digest: string) => {
      const matches = events.filter((event) => recoveryEventDigest(event) === digest);
      requireOutcome(matches.length === 1);
      return matches[0]!;
    };
    const sameAttempt = (event: FactoryEvent, runId: string, workItem: number, attempt: number) =>
      event.runId === runId &&
      "workItem" in event &&
      event.workItem === workItem &&
      "attempt" in event &&
      event.attempt === attempt;
    const assertUsage = (review: ReviewCheckpointRecord, prefix: string, before: number) => {
      const amount = review.usage.inputTokens + review.usage.outputTokens;
      const usage = events.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.runId === review.identity.runId &&
          event.workItem === review.identity.workItem &&
          (event.attempt === undefined || event.attempt === review.identity.attempt) &&
          event.phase === "management" &&
          event.unit === "model_tokens" &&
          event.usageId === `${prefix}-${review.identityDigest}` &&
          event.sequence < before,
      );
      requireOutcome(
        Number.isSafeInteger(amount) &&
          usage.length > 0 &&
          usage.every((event) => event.kind === "budget" && event.amount === amount),
      );
    };
    const verifyReservation = async (reserved: FactoryEvent, ref: string, oid: string) => {
      requireOutcome(
        reserved.kind === "attempt" &&
          reserved.event === "AttemptReserved" &&
          ref === attemptRef(plan.objective, reserved.workItem, reserved.attempt),
      );
      const commit = await store.readCommit(oid);
      const trailer = decodeEventTrailer(commit.message);
      requireOutcome(
        (await store.readRef(ref)) === oid &&
          commit.oid === oid &&
          trailer &&
          recoveryEventDigest(trailer) === recoveryEventDigest(reserved) &&
          commit.parentOids.length === 1 &&
          commit.parentOids[0] === reserved.baseSha &&
          (await store.readCommit(reserved.baseSha)).treeOid === commit.treeOid,
      );
    };
    const verifyMerge = async (args: {
      workItem: number;
      attempt: number;
      pullRequest: number;
      source: ExactHeadValidationEvidence;
      mergeCommitSha: string;
      before: number;
      candidateDigest?: string;
      deliveryHeadSha?: string;
      requireCandidateDigest: boolean;
    }) => {
      const merge = await store.readCommit(args.mergeCommitSha);
      const pull = await store.readPullRequest(args.pullRequest);
      requireOutcome(
        merge.oid === args.mergeCommitSha &&
          merge.parentOids.length === 1 &&
          pull.merged &&
          pull.number === args.pullRequest &&
          pull.baseRepository?.toLowerCase() === plan.repository.toLowerCase() &&
          pull.headSha === (args.deliveryHeadSha ?? args.source.publishedHeadSha) &&
          pull.mergeCommitSha === args.mergeCommitSha &&
          pull.baseRef === plan.baseBranch,
      );
      const targetBaseSha = merge.parentOids[0]!;
      let candidate: MergeCandidateCheckpointRecord | null = null;
      let candidateReview: ReviewCheckpointRecord | null = null;
      if (targetBaseSha === args.source.baseSha) {
        requireOutcome(
          !args.candidateDigest &&
            !args.deliveryHeadSha &&
            merge.treeOid === args.source.outputTreeSha,
        );
      } else {
        const identity = {
          runId: plan.successorRunId,
          objective: plan.objective,
          workItem: args.workItem,
          attempt: args.attempt,
          pullRequest: args.pullRequest,
          sourceHeadSha: args.source.publishedHeadSha,
          sourceExactHeadValidationDigest: args.source.digest,
          targetBaseSha,
        };
        const digest = mergeCandidateIdentityDigest(identity);
        requireOutcome(!args.requireCandidateDigest || args.candidateDigest === digest);
        candidate = await loadMergeCandidateCheckpoint(store, identity);
        requireOutcome(candidate);
        if (args.deliveryHeadSha) {
          const delivery = await store.readCommit(args.deliveryHeadSha);
          requireOutcome(
            delivery.oid === args.deliveryHeadSha &&
              delivery.parentOids.length === 1 &&
              delivery.parentOids[0] === targetBaseSha &&
              delivery.treeOid === candidate.validation.outputTreeSha,
          );
        }
        await verifyMergeCandidateSquash(
          store,
          args.source,
          candidate.evidence,
          args.mergeCommitSha,
        );
        candidateReview = await loadReviewCheckpoint(store, {
          kind: "integration-candidate",
          runId: plan.successorRunId,
          objective: plan.objective,
          workItem: args.workItem,
          attempt: args.attempt,
          headSha: args.source.publishedHeadSha,
          artifactDigest: candidate.validation.artifactDigest,
          baseSha: targetBaseSha,
          outputTreeSha: candidate.validation.outputTreeSha,
          evidenceDigest: candidate.validation.digest,
        });
        requireOutcome(
          candidateReview?.review.accepted && candidateReview.review.unmetCriteria.length === 0,
        );
        assertUsage(candidateReview, "integration-review", args.before);
        const duration =
          Date.parse(candidate.validation.completedAt) - Date.parse(candidate.validation.startedAt);
        const usage = events.filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.runId === plan.successorRunId &&
            event.workItem === args.workItem &&
            (event.attempt === undefined || event.attempt === args.attempt) &&
            event.phase === "validation" &&
            event.unit === "validation_milliseconds" &&
            event.usageId === `integration-validation-${digest}` &&
            event.sequence < args.before,
        );
        requireOutcome(
          usage.length > 0 &&
            usage.every((event) => event.kind === "budget" && event.amount === duration),
        );
      }
      return { targetBaseSha, outputTreeSha: merge.treeOid, candidate, candidateReview };
    };
    const checked = new Map<string, RecoverySourceIntegrationProof>();
    const visiting = new Set<string>();
    const advanceVisiting = new Set<string>();
    const advancesVerified = new Set<string>();
    const assertOwnAdvance = async (target: string, before: number): Promise<void> => {
      if (target === plan.expectedBaseSha) return;
      const ancestors = events.filter(
        (event) =>
          event.runId === plan.successorRunId &&
          event.sequence < before &&
          ((event.event === "RecoverySourceIntegrated" && event.mergeCommitSha === target) ||
            (event.event === "AttemptIntegrated" && event.headSha === target)),
      );
      requireOutcome(ancestors.length === 1);
      if (advancesVerified.has(target)) return;
      requireOutcome(!advanceVisiting.has(target) && advanceVisiting.size < plan.items.length + 1);
      advanceVisiting.add(target);
      const ancestor = ancestors[0]!;
      if (ancestor.event === "RecoverySourceIntegrated") {
        const proof = await verifySource(ancestor);
        await assertOwnAdvance(proof.targetBaseSha, ancestor.sequence);
      } else {
        requireOutcome(ancestor.kind === "attempt" && ancestor.event === "AttemptIntegrated");
        requireOutcome(
          plan.items.some(
            (item) => item.workItem === ancestor.workItem && item.action === "execute",
          ) && ancestor.policyDigest === plan.policyDigest,
        );
        const group = events.filter(
          (event) =>
            sameAttempt(event, plan.successorRunId, ancestor.workItem, ancestor.attempt) &&
            event.sequence < ancestor.sequence,
        );
        const reserved = group.filter((event) => event.event === "AttemptReserved");
        const publication = group.filter((event) => event.event === "PublicationRecorded").at(-1);
        const validation = group
          .filter((event) => event.kind === "validation" && event.passed)
          .at(-1);
        requireOutcome(
          reserved.length === 1 &&
            publication?.kind === "publication" &&
            validation?.kind === "validation" &&
            group.some(
              (event) =>
                event.event === "AttemptPublished" && event.headSha === publication.headSha,
            ),
        );
        const ref = attemptRef(plan.objective, ancestor.workItem, ancestor.attempt);
        const oid = await store.readRef(ref);
        requireOutcome(oid);
        requireOutcome(
          reserved[0]!.kind === "attempt" && reserved[0]!.policyDigest === plan.policyDigest,
        );
        await verifyReservation(reserved[0]!, ref, oid);
        const head = await store.readCommit(publication.headSha);
        requireOutcome(
          head.oid === publication.headSha &&
            head.parentOids.length === 1 &&
            head.parentOids[0] === validation.baseSha,
        );
        const source = bindValidationToPublishedHead({
          validation: {
            passed: true,
            digest: validation.evidenceDigest,
            baseSha: validation.baseSha,
            outputTreeSha: validation.outputTreeSha,
          },
          publishedHeadSha: head.oid,
          publishedTreeSha: head.treeOid,
          publishedBaseSha: validation.baseSha,
        });
        requireOutcome(
          publication.exactHeadValidationDigest === source.digest &&
            publication.baseSha === validation.baseSha &&
            publication.validationDigest === validation.evidenceDigest,
        );
        const proof = await verifyMerge({
          workItem: ancestor.workItem,
          attempt: ancestor.attempt,
          pullRequest: publication.pullRequest,
          source,
          mergeCommitSha: target,
          before: ancestor.sequence,
          requireCandidateDigest: false,
        });
        await assertOwnAdvance(proof.targetBaseSha, ancestor.sequence);
      }
      advanceVisiting.delete(target);
      advancesVerified.add(target);
    };
    const verifySource = async (
      raw: RecoverySourceIntegratedEvent,
    ): Promise<RecoverySourceIntegrationProof> => {
      const outcome = parseFactoryEvent(raw);
      requireOutcome(outcome.event === "RecoverySourceIntegrated");
      const digest = recoveryEventDigest(outcome);
      const previous = checked.get(digest);
      if (previous) return previous;
      requireOutcome(!visiting.has(digest) && visiting.size < plan.items.length + 1);
      visiting.add(digest);
      const sourcePublication = events.find(
        (event): event is RecoverySourcePublishedEvent =>
          event.event === "RecoverySourcePublished" &&
          event.runId === plan.successorRunId &&
          event.workItem === outcome.workItem,
      );
      if (sourcePublication)
        requireOutcome(
          (
            await verifyRecoverySourcePublication({
              planRecord: record,
              claim,
              store,
              events,
              publication: sourcePublication,
            })
          ).status === "verified" && sourcePublication.sequence < outcome.sequence,
        );
      const expected = createRecoverySourceIntegratedEvent({
        planRecord: record,
        claim,
        workItem: outcome.workItem,
        mergeCommitSha: outcome.mergeCommitSha,
        sequence: outcome.sequence,
        at: outcome.at,
        ...(sourcePublication ? { sourcePublication } : {}),
        ...(outcome.mergeCandidateIdentityDigest
          ? { mergeCandidateIdentityDigest: outcome.mergeCandidateIdentityDigest }
          : {}),
        ...(outcome.deliveryHeadSha ? { deliveryHeadSha: outcome.deliveryHeadSha } : {}),
      });
      requireOutcome(
        recoveryEventDigest(expected) === digest &&
          outcome.sequence > envelopes[2].sequence &&
          !events.some(
            (event) => event.sequence === outcome.sequence && recoveryEventDigest(event) !== digest,
          ) &&
          !events.some(
            (event) =>
              event.event === "RecoverySourceIntegrated" &&
              event.runId === plan.successorRunId &&
              event.workItem === outcome.workItem &&
              recoveryEventDigest(event) !== digest,
          ),
      );
      const material = await verifyMaterial(outcome, sourcePublication, outcome.sequence, true);
      const result: RecoverySourceIntegrationProof = {
        ...material,
        status: "verified",
        executionAuthorized: false,
        outcome,
      };
      visiting.delete(digest);
      checked.set(digest, result);
      return result;
    };
    const verifyMaterial = async (
      outcome: {
        workItem: number;
        mergeCommitSha: string;
        mergeCandidateIdentityDigest?: string | undefined;
        deliveryHeadSha?: string | undefined;
      },
      sourcePublication: RecoverySourcePublishedEvent | undefined,
      before: number,
      requireCandidateDigest: boolean,
    ): Promise<Omit<RecoverySourceIntegrationProof, "outcome">> => {
      const item = plan.items.find((value) => value.workItem === outcome.workItem)!;
      const source = item.source!;
      if (source.priorDelivery) {
        const prior = await verifyPriorRecoveryDelivery({ plan, item, events, store });
        requireOutcome(
          outcome.mergeCommitSha === prior.outcome.mergeCommitSha &&
            outcome.mergeCandidateIdentityDigest === prior.outcome.mergeCandidateIdentityDigest &&
            outcome.deliveryHeadSha === prior.outcome.deliveryHeadSha,
        );
        return prior;
      }
      const publicationBinding =
        source.publication ??
        (sourcePublication
          ? recoverySourcePublicationBinding(sourcePublication, plan.repository)
          : null);
      requireOutcome(publicationBinding);
      const reservation = exact(source.reservationReceiptDigest);
      requireOutcome(
        sameAttempt(reservation, source.runId, item.workItem, source.attempt) &&
          reservation.kind === "attempt" &&
          reservation.policyDigest ===
            plan.history.find((value) => value.runId === source.runId)?.policyDigest,
      );
      await verifyReservation(reservation, source.reservationRef, source.reservationCommitOid);
      const validation = exact(source.validation!.receiptDigest);
      const originalPublication = source.publication
        ? exact(source.publication.receiptDigest)
        : null;
      requireOutcome(
        validation.kind === "validation" &&
          validation.passed &&
          sameAttempt(validation, source.runId, item.workItem, source.attempt) &&
          validation.evidenceDigest === source.validation!.evidenceDigest &&
          validation.baseSha === source.validation!.baseSha &&
          validation.outputTreeSha === source.validation!.outputTreeSha,
      );
      if (originalPublication)
        requireOutcome(
          originalPublication.kind === "publication" &&
            originalPublication.event === "PublicationRecorded" &&
            sameAttempt(originalPublication, source.runId, item.workItem, source.attempt) &&
            originalPublication.itemId === item.compilerId &&
            originalPublication.mode === publicationBinding.mode &&
            (originalPublication.stackNumber ?? null) === publicationBinding.stackNumber &&
            originalPublication.pullRequest === publicationBinding.pullRequest &&
            originalPublication.branch === publicationBinding.branch &&
            originalPublication.baseSha === publicationBinding.baseSha &&
            originalPublication.baseBranch === publicationBinding.baseBranch &&
            originalPublication.headSha === publicationBinding.headSha,
        );
      const publication = {
        ...publicationBinding,
        validationDigest:
          originalPublication?.kind === "publication"
            ? originalPublication.validationDigest
            : sourcePublication!.sourceValidationDigest,
        exactHeadValidationDigest:
          originalPublication?.kind === "publication"
            ? originalPublication.exactHeadValidationDigest
            : sourcePublication!.exactHeadValidationDigest,
      };
      const head = await store.readCommit(publication.headSha);
      requireOutcome(
        head.oid === publication.headSha &&
          head.parentOids.length === 1 &&
          head.parentOids[0] === validation.baseSha,
      );
      const sourceProof = bindValidationToPublishedHead({
        validation: {
          passed: true,
          digest: validation.evidenceDigest,
          baseSha: validation.baseSha,
          outputTreeSha: validation.outputTreeSha,
        },
        publishedHeadSha: head.oid,
        publishedTreeSha: head.treeOid,
        publishedBaseSha: publication.baseSha,
      });
      requireOutcome(
        publication.exactHeadValidationDigest === sourceProof.digest &&
          publication.validationDigest === validation.evidenceDigest,
      );
      const reviewIdentity: ReviewIdentity = {
        kind: "artifact",
        runId: source.runId,
        objective: plan.objective,
        workItem: item.workItem,
        attempt: source.attempt,
        artifactDigest: source.artifactDigest!,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
        evidenceDigest: validation.evidenceDigest,
      };
      let review = await loadReviewCheckpoint(store, reviewIdentity);
      if (review?.ref !== source.review!.ref)
        review = await loadReviewCheckpoint(store, {
          ...reviewIdentity,
          kind: "rebase",
          headSha: head.oid,
        });
      requireOutcome(
        review &&
          review.ref === source.review!.ref &&
          review.commitOid === source.review!.commitOid &&
          review.blobOid === source.review!.blobOid &&
          review.identityDigest === source.review!.identityDigest &&
          review.review.accepted &&
          review.review.unmetCriteria.length === 0,
      );
      requireOutcome(
        review.identity.kind === "rebase" ||
          events.some(
            (event) =>
              sameAttempt(event, source.runId, item.workItem, source.attempt) &&
              event.event === "AttemptValidated" &&
              event.artifactDigest === source.artifactDigest,
          ),
      );
      assertUsage(
        review,
        review.identity.kind === "rebase" ? "rebase-review" : "review",
        plan.sourceEventMaxSequence + 1,
      );
      const pull = await store.readPullRequest(publication.pullRequest);
      requireOutcome(
        pull.number === publication.pullRequest &&
          pull.nodeId === publicationBinding.pullRequestNodeId &&
          pull.headRef === publicationBinding.branch &&
          pull.baseRepository?.toLowerCase() === plan.repository.toLowerCase() &&
          pull.headRepository?.toLowerCase() === publicationBinding.headRepository.toLowerCase(),
      );
      if (outcome.deliveryHeadSha) {
        requireOutcome(publication.mode === "native-stacks");
        const transition = await observeRecoveryNativeTransition({
          planRecord: record,
          events,
          store,
          workItem: item.workItem,
        });
        requireOutcome(
          transition.deliveryHeadSha === outcome.deliveryHeadSha &&
            transition.sourceHeadSha === publication.headSha,
        );
      }
      const proof = await verifyMerge({
        workItem: item.workItem,
        attempt: source.attempt,
        pullRequest: publication.pullRequest,
        source: sourceProof,
        mergeCommitSha: outcome.mergeCommitSha,
        before,
        requireCandidateDigest,
        ...(outcome.deliveryHeadSha ? { deliveryHeadSha: outcome.deliveryHeadSha } : {}),
        ...(outcome.mergeCandidateIdentityDigest
          ? { candidateDigest: outcome.mergeCandidateIdentityDigest }
          : {}),
      });
      if (item.action === "integrated") {
        requireOutcome(item.observedPullRequest?.state === "merged");
        const pending = [plan.expectedBaseSha];
        const seen = new Set<string>();
        let included = false;
        while (pending.length) {
          const cursor = pending.pop()!;
          if (cursor === outcome.mergeCommitSha) {
            included = true;
            break;
          }
          if (seen.has(cursor)) continue;
          requireOutcome(seen.size < 256);
          seen.add(cursor);
          const commit = await store.readCommit(cursor);
          requireOutcome(commit.oid === cursor && commit.parentOids.length <= 16);
          pending.push(...commit.parentOids);
        }
        requireOutcome(included);
      } else await assertOwnAdvance(proof.targetBaseSha, before);
      return {
        status: "verified",
        executionAuthorized: false,
        sourceExactHeadValidation: sourceProof,
        ...proof,
      };
    };
    if ("outcome" in input) return await verifySource(input.outcome);
    const item = plan.items.find((entry) => entry.workItem === input.workItem);
    requireOutcome(
      item?.source?.validation &&
        item.source.review &&
        !item.source.priorDelivery &&
        ["integrated", "reuse-publication", "reuse-artifact", "revalidate"].includes(item.action),
    );
    requireOutcome(
      !events.some(
        (event) =>
          event.event === "RecoverySourceIntegrated" &&
          event.runId === plan.successorRunId &&
          event.workItem === input.workItem,
      ),
    );
    const restored = events.filter(
      (event): event is RecoverySourcePublishedEvent =>
        event.event === "RecoverySourcePublished" &&
        event.runId === plan.successorRunId &&
        event.workItem === input.workItem,
    );
    requireOutcome(restored.length <= 1);
    const sourcePublication = restored[0];
    if (sourcePublication)
      requireOutcome(
        (
          await verifyRecoverySourcePublication({
            planRecord: record,
            claim,
            store,
            events,
            publication: sourcePublication,
          })
        ).status === "verified",
      );
    const publication =
      item.source.publication ??
      (sourcePublication
        ? recoverySourcePublicationBinding(sourcePublication, plan.repository)
        : null);
    requireOutcome(publication?.mode === "native-stacks");
    const pull = await store.readPullRequest(publication.pullRequest);
    requireOutcome(pull.merged && pull.mergeCommitSha);
    const deliveryHeadSha = pull.headSha !== publication.headSha ? pull.headSha : undefined;
    const material = await verifyMaterial(
      {
        workItem: input.workItem,
        mergeCommitSha: pull.mergeCommitSha,
        ...(deliveryHeadSha ? { deliveryHeadSha } : {}),
      },
      sourcePublication,
      Number.MAX_SAFE_INTEGER,
      false,
    );
    return {
      workItem: input.workItem,
      mergeCommitSha: pull.mergeCommitSha,
      ...(sourcePublication ? { sourcePublication } : {}),
      ...(material.candidate
        ? {
            mergeCandidateIdentityDigest: mergeCandidateIdentityDigest(material.candidate.identity),
          }
        : {}),
      ...(deliveryHeadSha ? { deliveryHeadSha } : {}),
    };
  } catch {
    return {
      status: "blocked",
      executionAuthorized: false,
      blockers: ["source-integration-unverified"],
    };
  }
}
