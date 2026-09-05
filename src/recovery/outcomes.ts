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
} from "./plan.js";
import { recoveryAdoptionEvents } from "./transaction.js";

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

/** Identity construction only. Verify actual merge evidence before appending this receipt. */
export function createRecoverySourceIntegratedEvent(input: {
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  workItem: number;
  mergeCommitSha: string;
  mergeCandidateIdentityDigest?: string;
  sequence: number;
  at: string;
}): RecoverySourceIntegratedEvent {
  const { planRecord: record, claim } = input;
  const plan = record.plan;
  const item = plan.items.find((value) => value.workItem === input.workItem);
  const source = item?.source;
  requireOutcome(
    record.digest === recoveryPlanDigest(plan) &&
      record.ref === recoveryPlanRef(plan.objective, record.digest) &&
      claim.planDigest === record.digest &&
      claim.successorRunId === plan.successorRunId &&
      claim.requestId === plan.requestId &&
      source?.publication &&
      source.validation &&
      source.review &&
      ["integrated", "reuse-publication", "revalidate"].includes(item!.action),
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
    sourcePublicationReceiptDigest: source.publication.receiptDigest,
    sourceHeadSha: source.publication.headSha,
    mergeCommitSha: input.mergeCommitSha,
    ...(input.mergeCandidateIdentityDigest
      ? { mergeCandidateIdentityDigest: input.mergeCandidateIdentityDigest }
      : {}),
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
export async function verifyRecoverySourceIntegration(input: {
  planRecord: RecoveryPlanRecord;
  claim: RecoveryClaimRecord;
  events: readonly FactoryEvent[];
  store: RecoveryReadStore;
  outcome: RecoverySourceIntegratedEvent;
}): Promise<RecoverySourceIntegrationResult> {
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
    const store = new Proxy(input.store, {
      get(target, property, receiver) {
        const operation = Reflect.get(target, property, receiver);
        if (typeof operation !== "function") return operation;
        return (...args: unknown[]) => {
          const key = JSON.stringify([property, args]);
          const previous = cache.get(key);
          if (previous) return previous;
          requireOutcome(++reads <= 1024);
          const pending = Promise.resolve().then(() => Reflect.apply(operation, target, args));
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
          pull.headSha === args.source.publishedHeadSha &&
          pull.mergeCommitSha === args.mergeCommitSha &&
          pull.baseRef === plan.baseBranch,
      );
      const targetBaseSha = merge.parentOids[0]!;
      let candidate: MergeCandidateCheckpointRecord | null = null;
      let candidateReview: ReviewCheckpointRecord | null = null;
      if (targetBaseSha === args.source.baseSha) {
        requireOutcome(!args.candidateDigest && merge.treeOid === args.source.outputTreeSha);
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
      const expected = createRecoverySourceIntegratedEvent({
        planRecord: record,
        claim,
        workItem: outcome.workItem,
        mergeCommitSha: outcome.mergeCommitSha,
        sequence: outcome.sequence,
        at: outcome.at,
        ...(outcome.mergeCandidateIdentityDigest
          ? { mergeCandidateIdentityDigest: outcome.mergeCandidateIdentityDigest }
          : {}),
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
      const item = plan.items.find((value) => value.workItem === outcome.workItem)!;
      const source = item.source!;
      const reservation = exact(source.reservationReceiptDigest);
      requireOutcome(
        sameAttempt(reservation, source.runId, item.workItem, source.attempt) &&
          reservation.kind === "attempt" &&
          reservation.policyDigest ===
            plan.history.find((value) => value.runId === source.runId)?.policyDigest,
      );
      await verifyReservation(reservation, source.reservationRef, source.reservationCommitOid);
      const validation = exact(source.validation!.receiptDigest);
      const publication = exact(source.publication!.receiptDigest);
      requireOutcome(
        validation.kind === "validation" &&
          validation.passed &&
          sameAttempt(validation, source.runId, item.workItem, source.attempt) &&
          validation.evidenceDigest === source.validation!.evidenceDigest &&
          validation.baseSha === source.validation!.baseSha &&
          validation.outputTreeSha === source.validation!.outputTreeSha &&
          publication.event === "PublicationRecorded" &&
          publication.kind === "publication" &&
          sameAttempt(publication, source.runId, item.workItem, source.attempt) &&
          publication.itemId === item.compilerId &&
          publication.mode === source.publication!.mode &&
          (publication.stackNumber ?? null) === source.publication!.stackNumber &&
          publication.pullRequest === source.publication!.pullRequest &&
          publication.branch === source.publication!.branch &&
          publication.baseSha === source.publication!.baseSha &&
          publication.baseBranch === source.publication!.baseBranch &&
          publication.headSha === source.publication!.headSha,
      );
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
          pull.nodeId === source.publication!.pullRequestNodeId &&
          pull.headRef === source.publication!.branch &&
          pull.baseRepository?.toLowerCase() === plan.repository.toLowerCase() &&
          pull.headRepository?.toLowerCase() === source.publication!.headRepository.toLowerCase(),
      );
      const proof = await verifyMerge({
        workItem: item.workItem,
        attempt: source.attempt,
        pullRequest: publication.pullRequest,
        source: sourceProof,
        mergeCommitSha: outcome.mergeCommitSha,
        before: outcome.sequence,
        requireCandidateDigest: true,
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
      } else await assertOwnAdvance(proof.targetBaseSha, outcome.sequence);
      const result: RecoverySourceIntegrationProof = {
        status: "verified",
        executionAuthorized: false,
        outcome,
        sourceExactHeadValidation: sourceProof,
        ...proof,
      };
      visiting.delete(digest);
      checked.set(digest, result);
      return result;
    };
    return await verifySource(input.outcome);
  } catch {
    return {
      status: "blocked",
      executionAuthorized: false,
      blockers: ["source-integration-unverified"],
    };
  }
}
