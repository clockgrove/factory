import type { AttemptReservation } from "../control/attempts.js";
import type { FactoryEvent } from "../protocol/events.js";
import { localScopeBatchDigest, type LocalScopeBatch } from "../protocol/local-scope.js";
import type { ValidationInvocation } from "./repository-capture.js";

type PreparedEvent = Extract<FactoryEvent, { event: "ValidationInvocationPrepared" }>;
type ScopeReboundEvent = Extract<FactoryEvent, { event: "ValidationInvocationScopeRebound" }>;
type CapacityEvent = Extract<FactoryEvent, { kind: "capacity" }>;

export interface AuthenticatedLocalValidationEventChain {
  capacity: CapacityEvent;
  prepared: PreparedEvent;
  originalScopeBatch: LocalScopeBatch;
  rebound?: ScopeReboundEvent;
}

/** Authenticate the complete local recovery chain. The original capacity and
 * preparation share one writer generation; a rebound may only advance to a
 * historically authenticated generation and must retain every scope invariant. */
export function inspectLocalValidationScopeReboundChain(args: {
  events: readonly FactoryEvent[];
  reservation: AttemptReservation;
  invocation: ValidationInvocation;
  capacity: CapacityEvent;
  isWriterAuthorized(event: FactoryEvent): boolean;
}): AuthenticatedLocalValidationEventChain {
  const candidates = args.events.filter(
    (event): event is PreparedEvent | ScopeReboundEvent =>
      event.kind === "validation-invocation" &&
      event.runId === args.reservation.runId &&
      event.workItem === args.reservation.workItem &&
      event.attempt === args.reservation.attempt &&
      ["ValidationInvocationPrepared", "ValidationInvocationScopeRebound"].includes(event.event),
  );
  if (
    !args.isWriterAuthorized(args.capacity) ||
    candidates.some((event) => !args.isWriterAuthorized(event))
  )
    throw new Error("local validation invocation contains unauthenticated writer authority");
  const originalScopeBatch = args.capacity.localScopeBatch;
  const originalScope = originalScopeBatch?.identity;
  if (
    args.capacity.event !== "CapacityReserved" ||
    args.capacity.runId !== args.reservation.runId ||
    args.capacity.workItem !== args.reservation.workItem ||
    args.capacity.attempt !== args.reservation.attempt ||
    args.capacity.phase !== "validation" ||
    args.capacity.backend !== args.invocation.toolEnvironment.backendId ||
    args.capacity.directorEpoch !== args.reservation.directorEpoch ||
    args.capacity.policyDigest !== args.reservation.policyDigest ||
    args.capacity.writerEpoch !== (args.capacity.recoveryEpoch ?? args.capacity.directorEpoch) ||
    args.capacity.writerPolicyDigest !== args.capacity.policyDigest ||
    !originalScopeBatch ||
    !originalScope ||
    originalScope.repository !== args.invocation.repository.toLowerCase() ||
    originalScope.objective !== args.reservation.objective ||
    originalScope.runId !== args.reservation.runId ||
    originalScope.workItem !== args.reservation.workItem ||
    originalScope.attempt !== args.reservation.attempt ||
    originalScope.policyDigest !== args.reservation.policyDigest ||
    originalScope.directorEpoch !== (args.capacity.recoveryEpoch ?? args.capacity.directorEpoch) ||
    originalScope.phase !== "validation" ||
    originalScope.commandIndex !== 0 ||
    originalScope.invocationDigest !== args.invocation.artifactDigest ||
    originalScopeBatch.deadline !== args.invocation.validationDeadline ||
    !originalScope.producerUnit ||
    !originalScope.producerInvocationId
  )
    throw new Error("local validation invocation differs from its exact capacity reservation");

  const preparedEvents = candidates.filter(
    (event): event is PreparedEvent => event.event === "ValidationInvocationPrepared",
  );
  const rebounds = candidates.filter(
    (event): event is ScopeReboundEvent => event.event === "ValidationInvocationScopeRebound",
  );
  if (preparedEvents.length !== 1 || rebounds.length > 1)
    throw new Error("local validation invocation has conflicting durable phases");
  const prepared = preparedEvents[0]!;
  const authority = args.invocation.attemptAuthority;
  if (
    prepared.invocationDigest !== args.invocation.digest ||
    prepared.artifactDigest !== args.invocation.artifactDigest ||
    prepared.baseSha !== args.invocation.baseSha ||
    prepared.outputTreeSha !== args.invocation.outputTreeSha ||
    prepared.backend !== args.invocation.toolEnvironment.backendId ||
    prepared.backendLocator !== args.invocation.toolEnvironment.backendLocator ||
    prepared.reservationRef !== authority.reservationRef ||
    prepared.reservationOid !== authority.reservationOid ||
    prepared.reservationReceiptDigest !== authority.reservationReceiptDigest ||
    prepared.attemptDirectorEpoch !== authority.directorEpoch ||
    prepared.attemptPolicyDigest !== authority.policyDigest ||
    prepared.validationDeadline !== args.invocation.validationDeadline ||
    prepared.capacityReservationSequence !== args.capacity.sequence ||
    prepared.sequence <= args.capacity.sequence
  )
    throw new Error("local validation prepared event differs from immutable authority");
  if (
    prepared.writerEpoch !== args.capacity.writerEpoch ||
    prepared.writerHolder !== args.capacity.writerHolder ||
    prepared.writerPolicyDigest !== args.capacity.writerPolicyDigest
  )
    throw new Error("local validation preparation differs from its capacity writer");

  const rebound = rebounds[0];
  if (rebound) {
    const replacement = rebound.localScopeBatch;
    const replacementScope = replacement.identity;
    if (
      rebound.reservationOid !== args.reservation.oid ||
      rebound.artifactDigest !== args.invocation.artifactDigest ||
      rebound.invocationDigest !== args.invocation.digest ||
      rebound.backend !== args.invocation.toolEnvironment.backendId ||
      rebound.previousScopeBatchDigest !== localScopeBatchDigest(originalScopeBatch) ||
      rebound.sequence <= prepared.sequence ||
      replacement.commandCount !== originalScopeBatch.commandCount ||
      replacement.deadline !== originalScopeBatch.deadline ||
      replacementScope.repository !== originalScope.repository ||
      replacementScope.objective !== originalScope.objective ||
      replacementScope.runId !== originalScope.runId ||
      replacementScope.workItem !== originalScope.workItem ||
      replacementScope.attempt !== originalScope.attempt ||
      replacementScope.policyDigest !== originalScope.policyDigest ||
      replacementScope.phase !== originalScope.phase ||
      replacementScope.commandIndex !== originalScope.commandIndex ||
      replacementScope.invocationDigest !== originalScope.invocationDigest ||
      replacementScope.hostIdentity !== originalScope.hostIdentity ||
      replacementScope.producerUnit !== originalScope.producerUnit ||
      replacementScope.producerInvocationId === originalScope.producerInvocationId ||
      replacementScope.directorEpoch !== rebound.writerEpoch ||
      rebound.writerPolicyDigest !== args.reservation.policyDigest ||
      rebound.writerEpoch! < prepared.writerEpoch! ||
      (rebound.writerEpoch === prepared.writerEpoch &&
        rebound.writerHolder !== prepared.writerHolder)
    )
      throw new Error("local validation rebound breaks its immutable writer and scope chain");
  }
  return {
    capacity: args.capacity,
    prepared,
    originalScopeBatch,
    ...(rebound ? { rebound } : {}),
  };
}
